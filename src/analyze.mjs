import path from 'node:path';
import { findFfmpegTools, probeMedia } from './ffmpeg.mjs';
import { runProcess } from './process.mjs';

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function combinedLog(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

export function parseTimedMetadata(text, key) {
  const points = [];
  let time = null;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const valuePattern = new RegExp(`${escaped}=([^\\s]+)`);
  for (const line of String(text).split(/\r?\n/)) {
    const timeMatch = line.match(/(?:pts_time[:=]|pts_time=)(-?[0-9.]+)/);
    if (timeMatch) time = finite(timeMatch[1], null);
    const valueMatch = line.match(valuePattern);
    if (valueMatch && time != null) {
      const value = /^-?inf$/i.test(valueMatch[1]) ? -90 : finite(valueMatch[1], null);
      if (value != null) points.push({ time, value });
    }
  }
  return points;
}

export function parseScenes(text) {
  const scenes = [];
  for (const match of String(text).matchAll(/showinfo[^\r\n]*?pts_time:\s*(-?[0-9.]+)/g)) {
    const time = finite(match[1], null);
    if (time != null && time >= 0) scenes.push(time);
  }
  return [...new Set(scenes.map((value) => Number(value.toFixed(3))))].sort((a, b) => a - b);
}

export function parseBlackIntervals(text) {
  const intervals = [];
  for (const match of String(text).matchAll(/black_start:([0-9.]+)\s+black_end:([0-9.]+)\s+black_duration:([0-9.]+)/g)) {
    intervals.push({
      start: finite(match[1]),
      end: finite(match[2]),
      duration: finite(match[3]),
    });
  }
  return intervals;
}

/**
 * One decode for scenes, black frames AND motion (two filter branches from one split), instead of two
 * full decodes. Long recordings (> 30 min) are sampled at 2 fps instead of 4.
 */
async function analyzeVideo(file, tools, onProgress, duration = 0) {
  const featureWarnings = [];
  let scenes = [];
  let black = [];
  let motion = [];
  const audio = [];
  const rate = duration > 1800 ? 2 : 4;
  onProgress?.({ phase: 'video', file });
  try {
    const result = await runProcess(tools.ffmpeg, [
      '-hide_banner', '-nostats', '-loglevel', 'info', '-protocol_whitelist', 'file,pipe', '-threads', '2', '-i', file,
      '-filter_complex', `[0:v:0]fps=${rate},scale=320:-2:flags=area,split=2[s][m];`
        + "[s]blackdetect=d=0.25:pic_th=0.97:pix_th=0.10,select='gt(scene,0.22)',showinfo,nullsink;"
        + '[m]crop=trunc(iw*0.9/2)*2:trunc(ih*0.9/2)*2:(iw-ow)/2:(ih-oh)/2,format=gray,tblend=all_mode=difference,signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG[out]',
      '-map', '[out]', '-an', '-f', 'null', '-',
    ], { timeoutMs: 4 * 60 * 60_000, maxOutputBytes: 96 * 1024 * 1024 });
    const log = combinedLog(result);
    scenes = parseScenes(log);
    black = parseBlackIntervals(log);
    motion = parseTimedMetadata(log, 'lavfi.signalstats.YAVG');
  } catch (error) {
    featureWarnings.push(`Video analysis skipped: ${error.message}`);
  }
  return { scenes, black, motion, audio, featureWarnings };
}

async function analyzeAudio(file, tools, onProgress) {
  onProgress?.({ phase: 'audio', file });
  const result = await runProcess(tools.ffmpeg, [
    '-hide_banner', '-nostats', '-loglevel', 'info', '-protocol_whitelist', 'file,pipe', '-threads', '2', '-i', file,
    '-map', '0:a:0',
    '-af', 'aresample=16000,asetnsamples=n=8000:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level',
    '-vn', '-f', 'null', '-',
  ], { timeoutMs: 2 * 60 * 60_000, maxOutputBytes: 48 * 1024 * 1024 });
  return parseTimedMetadata(combinedLog(result), 'lavfi.astats.Overall.RMS_level');
}

export async function analyzeFiles(files, { tools = findFfmpegTools(), onProgress } = {}) {
  const sources = [];
  const warnings = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = path.resolve(files[index]);
    onProgress?.({ phase: 'probe', file, index, total: files.length, progress: index / files.length });
    let probe;
    try {
      probe = await probeMedia(file, tools);
    } catch (error) {
      warnings.push(`${path.basename(file)}: skipped as invalid or unreadable media (${error.message}).`);
      onProgress?.({
        phase: 'skipped', file, index: index + 1, total: files.length,
        progress: (index + 1) / files.length,
        error: error.message,
      });
      continue;
    }
    const features = await analyzeVideo(file, tools, onProgress, probe.duration);
    if (probe.audio) {
      try {
        features.audio = await analyzeAudio(file, tools, onProgress);
      } catch (error) {
        features.featureWarnings.push(`Audio analysis skipped: ${error.message}`);
      }
    }
    warnings.push(...features.featureWarnings.map((warning) => `${path.basename(file)}: ${warning}`));
    sources.push({
      ...probe,
      hasAudio: Boolean(probe.audio),
      audioStream: probe.audio,
      ...features,
    });
    onProgress?.({
      phase: 'analyzed', file, index: index + 1, total: files.length,
      progress: (index + 1) / files.length,
    });
  }

  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sourceCount: sources.length,
    totalDuration: sources.reduce((sum, source) => sum + source.duration, 0),
    sources,
    warnings,
  };
}
