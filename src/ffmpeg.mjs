import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { DATA_ROOT, PROJECT_ROOT, StudioError } from './paths.mjs';
import { runProcess } from './process.mjs';

function pathCandidates(name, envName) {
  const extension = process.platform === 'win32' ? '.exe' : '';
  const executable = `${name}${extension}`;
  const candidates = [
    process.env[envName],
    path.join(DATA_ROOT, 'tools', 'ffmpeg', 'bin', executable),
    path.join(PROJECT_ROOT, 'tools', 'ffmpeg', 'bin', executable),
    // Homebrew's complete build is keg-only (not on PATH); the plain "ffmpeg" formula has no text rendering.
    ...(process.platform === 'darwin' ? ['/opt/homebrew/opt/ffmpeg-full/bin', '/usr/local/opt/ffmpeg-full/bin'].map(dir => path.join(dir, executable)) : []),
  ].filter(Boolean);

  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (directory) candidates.push(path.join(directory, executable));
  }
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

/** How to get an FFmpeg build with everything the editor uses (libx264, drawtext, libass) on this OS. */
export function ffmpegInstallHint(platform = process.platform) {
  if (platform === 'darwin') return 'Install the complete build: brew install ffmpeg-full (the plain "ffmpeg" formula cannot draw text or captions).';
  if (platform === 'win32') return 'Install it: winget install Gyan.FFmpeg';
  return 'Install it with your package manager (e.g. sudo apt install ffmpeg).';
}

function findExecutable(name, envName) {
  for (const candidate of pathCandidates(name, envName)) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next fixed candidate.
    }
  }
  throw new StudioError(
    'DEPENDENCY_MISSING',
    `${name} was not found. ${ffmpegInstallHint()} Or put it in ${path.join(DATA_ROOT, 'tools', 'ffmpeg', 'bin')}.`,
  );
}

/** FFmpeg 7+ reads option values from files ("-/filter_complex file"); FFmpeg 9 removed -filter_complex_script. */
export const supportsFileOptions = versionText => { const m = String(versionText).match(/ffmpeg version n?(\d+)\./); return m ? Number(m[1]) >= 7 : true; };
const fileOptionCache = new Map();
/** Arguments that load a filter graph from a file, for this FFmpeg build (version checked once per binary). */
export function filterComplexFile(file, ffmpeg) {
  if (!fileOptionCache.has(ffmpeg)) {
    const r = spawnSync(ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    fileOptionCache.set(ffmpeg, supportsFileOptions(`${r.stdout ?? ''}${r.stderr ?? ''}`));
  }
  return fileOptionCache.get(ffmpeg) ? ['-/filter_complex', file] : ['-filter_complex_script', file];
}

export function findFfmpegTools() {
  return {
    ffmpeg: findExecutable('ffmpeg', 'FFMPEG_PATH'),
    ffprobe: findExecutable('ffprobe', 'FFPROBE_PATH'),
  };
}

function firstLine(value) {
  return String(value ?? '').split(/\r?\n/, 1)[0];
}

export async function inspectFfmpeg({ smokeTest = true, tools = findFfmpegTools() } = {}) {
  const inspectOptions = { timeoutMs: 30_000, maxOutputBytes: 8 * 1024 * 1024 };
  const [version, probeVersion, encoders, devices, filters] = await Promise.all([
    runProcess(tools.ffmpeg, ['-hide_banner', '-version'], inspectOptions),
    runProcess(tools.ffprobe, ['-hide_banner', '-version'], inspectOptions),
    runProcess(tools.ffmpeg, ['-hide_banner', '-encoders'], inspectOptions),
    runProcess(tools.ffmpeg, ['-hide_banner', '-devices'], inspectOptions),
    runProcess(tools.ffmpeg, ['-hide_banner', '-filters'], inspectOptions),
  ]);

  const allEncoders = `${encoders.stdout}\n${encoders.stderr}`;
  const allDevices = `${devices.stdout}\n${devices.stderr}`;
  const allFilters = `${filters.stdout}\n${filters.stderr}`;
  const capabilities = {
    h264Nvenc: /\bh264_nvenc\b/.test(allEncoders),
    av1Nvenc: /\bav1_nvenc\b/.test(allEncoders),
    libx264: /\blibx264\b/.test(allEncoders),
    gdigrab: /\bgdigrab\b/.test(allDevices),
    dshow: /\bdshow\b/.test(allDevices),
    drawtext: /\bdrawtext\b/.test(allFilters),
    xfade: /\bxfade\b/.test(allFilters),
    whisper: /\bwhisper\b/.test(allFilters),
    ass: /^\s*\S+\s+ass\s/m.test(allFilters),
    lut3d: /\blut3d\b/.test(allFilters), vidstab: /\bvidstabdetect\b/.test(allFilters) && /\bvidstabtransform\b/.test(allFilters),
    colortemperature: /\bcolortemperature\b/.test(allFilters), deshake: /\bdeshake\b/.test(allFilters),
    // FFmpeg 7+ reads option values from files with "-/option"; older builds need -filter_complex_script.
    fileOptions: supportsFileOptions(`${version.stdout}${version.stderr}`),
  };

  let nvencReady = false;
  let nvencError = null;
  if (smokeTest && capabilities.h264Nvenc) {
    try {
      await runProcess(tools.ffmpeg, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=s=640x360:r=60:d=0.15',
        '-frames:v', '3', '-c:v', 'h264_nvenc', '-f', 'null', '-',
      ], { timeoutMs: 20_000 });
      nvencReady = true;
    } catch (error) {
      nvencError = error.message;
    }
  }

  return {
    tools,
    version: firstLine(version.stdout || version.stderr),
    probeVersion: firstLine(probeVersion.stdout || probeVersion.stderr),
    capabilities: { ...capabilities, nvencReady },
    nvencError,
  };
}

function parseRate(value) {
  if (!value || value === '0/0') return 0;
  const [numerator, denominator = '1'] = String(value).split('/').map(Number);
  return denominator ? numerator / denominator : 0;
}

export async function probeMedia(file, tools = findFfmpegTools()) {
  const result = await runProcess(tools.ffprobe, [
    '-protocol_whitelist', 'file,pipe',
    '-v', 'error',
    '-of', 'json',
    '-show_format',
    '-show_streams',
    file,
  ], { timeoutMs: 60_000, maxOutputBytes: 4 * 1024 * 1024 });

  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch (error) {
    throw new StudioError('PROBE_PARSE_FAILED', `ffprobe returned invalid JSON for ${file}.`, { cause: error });
  }

  const videos = (data.streams ?? []).filter(
    (stream) => stream.codec_type === 'video' && Number(stream.disposition?.attached_pic ?? 0) !== 1,
  );
  const video = videos.find((stream) => Number(stream.disposition?.default ?? 0) === 1) ?? videos[0];
  const audio = data.streams?.find((stream) => stream.codec_type === 'audio');
  const duration = Number(data.format?.duration ?? video?.duration ?? 0);
  if (!video || !Number.isFinite(duration) || duration <= 0) {
    throw new StudioError('UNSUPPORTED_MEDIA', `No usable video stream found in ${file}.`);
  }

  return {
    file: path.resolve(file),
    duration,
    size: Number(data.format?.size ?? 0),
    bitrate: Number(data.format?.bit_rate ?? 0),
    format: data.format?.format_name ?? '',
    video: {
      index: video.index,
      codec: video.codec_name ?? '',
      width: Number(video.width ?? 0),
      height: Number(video.height ?? 0),
      fps: parseRate(video.avg_frame_rate || video.r_frame_rate),
      pixelFormat: video.pix_fmt ?? '',
      colorTransfer: video.color_transfer ?? '',
      colorPrimaries: video.color_primaries ?? '',
    },
    audio: audio ? {
      index: audio.index,
      codec: audio.codec_name ?? '',
      sampleRate: Number(audio.sample_rate ?? 0),
      channels: Number(audio.channels ?? 0),
    } : null,
  };
}

/** A still image as a 60-second virtual source: width/height from ffprobe, no audio. */
export async function probeStill(file, tools = findFfmpegTools(), seconds = 60) {
  const result = await runProcess(tools.ffprobe, ['-protocol_whitelist', 'file,pipe', '-v', 'error', '-of', 'json', '-show_streams', file], { timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 });
  const data = JSON.parse(result.stdout), video = data.streams?.find(s => s.codec_type === 'video');
  if (!video || !(Number(video.width) > 0) || !(Number(video.height) > 0)) throw new StudioError('UNSUPPORTED_MEDIA', `No usable image in ${file}.`);
  return { file: path.resolve(file), duration: seconds, still: true, size: 0, bitrate: 0, format: 'image',
    video: { index: video.index, codec: video.codec_name ?? '', width: Number(video.width), height: Number(video.height), fps: 0, pixelFormat: video.pix_fmt ?? '', colorTransfer: '', colorPrimaries: '' }, audio: null };
}

export async function probeAudio(file, tools = findFfmpegTools()) {
  const result = await runProcess(tools.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_format', '-show_streams', '-of', 'json', file], { timeoutMs: 30000, maxOutputBytes: 1024 * 1024 });
  const data = JSON.parse(result.stdout), stream = data.streams?.find(s => s.codec_type === 'audio');
  const duration = Number(data.format?.duration ?? stream?.duration);
  if (!stream || !Number.isFinite(duration) || duration <= 0) throw new StudioError('INVALID_AUDIO', 'No usable audio found.');
  return { duration, channels: stream.channels };
}

export async function verifyVideo(file, tools = findFfmpegTools()) {
  const probe = await probeMedia(file, tools);
  await runProcess(tools.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-xerror', '-protocol_whitelist', 'file,pipe', '-i', file,
    '-map', `0:${probe.video.index}`, '-map', '0:a?', '-f', 'null', '-',
  ], { timeoutMs: 30 * 60_000, maxOutputBytes: 4 * 1024 * 1024 });
  return probe;
}
