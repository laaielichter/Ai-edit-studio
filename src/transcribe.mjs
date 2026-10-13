// Local speech recognition. Nothing leaves the machine: whisper.cpp (whisper-cli) or
// FFmpeg's own whisper filter (FFmpeg 8+ built with whisper), both with a local ggml model.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DATA_ROOT, PROJECT_ROOT, StudioError } from './paths.mjs';
import { findFfmpegTools, inspectFfmpeg } from './ffmpeg.mjs';
import { runProcess } from './process.mjs';
import { normalizeWords, wordsFromSegments } from '../public/transcript.js';
import { parseSrt } from '../public/captions.js';

const exe = name => `${name}${process.platform === 'win32' ? '.exe' : ''}`;
export const WHISPER_ROOT = path.join(DATA_ROOT, 'tools', 'whisper');
export const MODEL_ORDER = ['large-v3-turbo-q5_0', 'large-v3-turbo', 'small', 'base', 'small.en', 'base.en', 'medium', 'medium.en', 'large-v3', 'tiny', 'tiny.en'];
export const MODEL_SIZES = { tiny: '75 MB', base: '142 MB', small: '466 MB', medium: '1.5 GB', 'large-v3-turbo': '1.6 GB', 'large-v3-turbo-q5_0': '547 MB' };

function walk(dir, depth = 3) {
  const found = [];
  try {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory() && depth > 0) found.push(...walk(full, depth - 1));
      else if (item.isFile()) found.push(full);
    }
  } catch { /* missing folder */ }
  return found;
}
const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };

/** whisper.cpp command-line binary: env, data root, app folder, then PATH. */
export function findWhisperCli() {
  const names = [exe('whisper-cli'), exe('whisper-cpp'), exe('whisper')];
  const fixed = [process.env.WHISPER_CPP_PATH, ...[WHISPER_ROOT, path.join(PROJECT_ROOT, 'tools', 'whisper')].flatMap(root => walk(root).filter(f => names.includes(path.basename(f)) || path.basename(f) === exe('main')))];
  for (const candidate of fixed) if (candidate && isFile(candidate)) return path.resolve(candidate);
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) for (const name of names.slice(0, 2)) if (dir && isFile(path.join(dir, name))) return path.join(dir, name);
  return null;
}

/** Local ggml models (ggml-<name>.bin). */
export function listModels() {
  const files = [process.env.WHISPER_MODEL, ...[WHISPER_ROOT, path.join(PROJECT_ROOT, 'tools', 'whisper')].flatMap(root => walk(root))]
    .filter(f => f && /ggml-.+\.bin$/i.test(path.basename(f)) && !/for-tests|silero|vad/i.test(path.basename(f)) && isFile(f));
  return [...new Set(files.map(f => path.resolve(f)))].map(file => ({ file, name: path.basename(file).replace(/^ggml-|\.bin$/gi, ''), bytes: fs.statSync(file).size }));
}
export function pickModel(wanted) {
  const models = listModels();
  if (wanted) {
    const hit = models.find(m => m.name === wanted || m.file === wanted);
    if (!hit) throw new StudioError('ASR_MODEL_MISSING', `Speech model "${wanted}" is not installed. Installed: ${models.map(m => m.name).join(', ') || 'none'}.`);
    return hit;
  }
  return models.sort((a, b) => (MODEL_ORDER.indexOf(a.name) + 99) % 99 - (MODEL_ORDER.indexOf(b.name) + 99) % 99)[0] ?? null;
}

/** What can transcribe here, without running anything heavy. */
export async function speechStatus({ tools } = {}) {
  const cli = findWhisperCli();
  const models = listModels();
  let ffmpegWhisper = false;
  try { ffmpegWhisper = Boolean((await inspectFfmpeg({ smokeTest: false, tools: tools ?? findFfmpegTools() })).capabilities.whisper); } catch { /* no ffmpeg */ }
  const engine = models.length ? (cli ? 'whisper.cpp' : ffmpegWhisper ? 'ffmpeg-whisper' : null) : null;
  return {
    ready: Boolean(engine), engine, whisperCli: cli, ffmpegWhisper, models: models.map(m => ({ name: m.name, bytes: m.bytes })),
    folder: WHISPER_ROOT,
    setup: engine ? null : process.platform === 'win32'
      ? 'Run "node cli.mjs speech-setup" (downloads whisper.cpp from GitHub and a model from Hugging Face into the data folder), or click "Install speech engine" in the Transcript tab.'
      : 'Install whisper.cpp (e.g. "brew install whisper-cpp") and run "node cli.mjs speech-setup --model base" to fetch a model.',
    privacy: 'Runs fully on this computer. Audio never leaves the machine.',
  };
}

/** whisper.cpp -ojf: tokens with offsets → words (tokens starting with a space start a new word). */
export function parseWhisperJson(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const language = data?.result?.language ?? data?.params?.language ?? null;
  const words = [];
  const segments = [];
  for (const seg of data?.transcription ?? []) {
    const segStart = Number(seg.offsets?.from) / 1000, segEnd = Number(seg.offsets?.to) / 1000;
    segments.push({ start: segStart, end: segEnd, text: String(seg.text ?? '').trim() });
    let cur = null;
    for (const tok of seg.tokens ?? []) {
      const text = String(tok.text ?? '');
      if (!text || /^\[_[A-Z]+_?\d*\]$|^<\|.*\|>$|^\[_TT_\d+\]$/.test(text.trim())) continue;
      const from = Number(tok.offsets?.from) / 1000, to = Number(tok.offsets?.to) / 1000;
      const startsWord = /^\s/.test(text) || !cur;
      const piece = text.trim();
      if (!piece) continue;
      // Punctuation tokens attach to the previous word.
      if (cur && !startsWord) { cur.text += piece; cur.end = Math.max(cur.end, to); cur.p = Math.min(cur.p, Number(tok.p ?? 1)); continue; }
      if (cur && /^[.,!?;:…'"”’)]+$/.test(piece)) { cur.text += piece; continue; }
      cur = { start: from, end: to, text: piece, p: Number(tok.p ?? 1) };
      words.push(cur);
    }
  }
  return { language, words: normalizeWords(words), segments };
}

async function extractAudio(file, wav, tools, { start, duration } = {}) {
  await runProcess(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...(start ? ['-ss', String(start)] : []), '-protocol_whitelist', 'file,pipe', '-i', file,
    ...(duration ? ['-t', String(duration)] : []), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { timeoutMs: 60 * 60_000 });
}
const filterPath = value => path.resolve(value).replaceAll('\\', '/').replace(':', '\\:').replaceAll("'", "\\'");

/**
 * Transcribe one media file. Returns {engine, model, language, words, segments}.
 * language: 'auto' or an ISO code ('en', 'nl', …).
 */
export async function transcribeFile(file, { language = 'auto', model: wanted, workDir, onProgress, tools = findFfmpegTools(), threads } = {}) {
  const model = pickModel(wanted);
  const status = await speechStatus({ tools });
  if (!model || !status.engine) throw new StudioError('ASR_UNAVAILABLE', `No local speech engine installed. ${status.setup ?? ''}`.trim());
  if (!/^(auto|[a-z]{2,3})$/.test(language)) throw new StudioError('INVALID_LANGUAGE', 'language: "auto" or a two-letter code such as en or nl.');
  await fsp.mkdir(workDir, { recursive: true });
  const n = String(Math.max(1, Math.min(8, threads ?? os.cpus().length - 1)));
  if (status.whisperCli) {
    const wav = path.join(workDir, 'speech.wav');
    onProgress?.({ phase: 'audio', progress: 0.02 });
    await extractAudio(file, wav, tools);
    const base = path.join(workDir, 'speech');
    let last = 0;
    await runProcess(status.whisperCli, ['-m', model.file, '-f', wav, '-l', language, '-t', n, '-ojf', '-of', base, '-pp', '-np'], {
      timeoutMs: 4 * 60 * 60_000, maxOutputBytes: 8 * 1024 * 1024,
      onLine(line) { const m = String(line).match(/progress\s*=\s*(\d+)%/); if (m && +m[1] !== last) { last = +m[1]; onProgress?.({ phase: 'speech', progress: 0.05 + 0.9 * last / 100 }); } },
    });
    const parsed = parseWhisperJson(await fsp.readFile(`${base}.json`, 'utf8'));
    await fsp.rm(wav, { force: true }).catch(() => {});
    return { engine: 'whisper.cpp', model: model.name, language: parsed.language ?? language, words: parsed.words, segments: parsed.segments, wordTiming: 'token' };
  }
  // FFmpeg whisper filter: segment timings; words are spread over each segment by length.
  const srt = path.join(workDir, 'speech.srt');
  await fsp.rm(srt, { force: true }).catch(() => {});
  await runProcess(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', file, '-vn',
    '-af', `aresample=16000,whisper=model='${filterPath(model.file)}':language=${language}:queue=10:destination='${filterPath(srt)}':format=srt`, '-f', 'null', '-'],
  { timeoutMs: 4 * 60 * 60_000 });
  const cues = parseSrt(await fsp.readFile(srt, 'utf8'), 0);
  const segments = cues.map(c => ({ start: c.start, end: c.end, text: c.text }));
  return { engine: 'ffmpeg-whisper', model: model.name, language, words: wordsFromSegments(segments), segments, wordTiming: 'estimated' };
}

/** Downloads whisper.cpp (Windows release zip) and a model into the data folder. Explicit user action only. */
export async function setupSpeech({ model = 'base', onLog = () => {}, fetchImpl = fetch } = {}) {
  if (!/^[a-z0-9.\-_]{2,40}$/.test(model)) throw new StudioError('INVALID_MODEL', 'Invalid model name.');
  await fsp.mkdir(path.join(WHISPER_ROOT, 'models'), { recursive: true });
  const result = { folder: WHISPER_ROOT, downloaded: [] };
  if (!findWhisperCli()) {
    if (process.platform !== 'win32') throw new StudioError('ASR_SETUP_MANUAL', 'Install whisper.cpp with your package manager (e.g. brew install whisper-cpp), then run speech-setup again for the model.');
    onLog('Looking up the latest whisper.cpp release on GitHub…');
    const release = await (await fetchImpl('https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ai-edit-studio' } })).json();
    const asset = (release.assets ?? []).find(a => a.name === 'whisper-bin-x64.zip');
    if (!asset) throw new StudioError('ASR_SETUP_FAILED', 'whisper-bin-x64.zip was not found in the latest whisper.cpp release.');
    const zip = path.join(WHISPER_ROOT, asset.name);
    await download(asset.browser_download_url, zip, fetchImpl, onLog);
    onLog('Unpacking…');
    await runProcess('tar', ['-xf', zip, '-C', WHISPER_ROOT], { timeoutMs: 10 * 60_000 });
    await fsp.rm(zip, { force: true });
    result.downloaded.push(asset.name);
    if (!findWhisperCli()) throw new StudioError('ASR_SETUP_FAILED', 'whisper-cli.exe was not found after unpacking.');
  }
  if (!listModels().some(m => m.name === model)) {
    const target = path.join(WHISPER_ROOT, 'models', `ggml-${model}.bin`);
    await download(`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`, target, fetchImpl, onLog);
    result.downloaded.push(`ggml-${model}.bin`);
  }
  return { ...result, status: await speechStatus() };
}
async function download(url, target, fetchImpl, onLog) {
  onLog(`Downloading ${url}`);
  const response = await fetchImpl(url, { redirect: 'follow', headers: { 'User-Agent': 'ai-edit-studio' } });
  if (!response.ok || !response.body) throw new StudioError('DOWNLOAD_FAILED', `Download failed (${response.status}): ${url}`);
  const partial = `${target}.partial`;
  const handle = await fsp.open(partial, 'w');
  let received = 0, shown = 0; const total = Number(response.headers.get('content-length')) || 0;
  try {
    for await (const chunk of response.body) {
      await handle.write(chunk); received += chunk.length;
      if (received - shown > 25 * 1024 ** 2) { shown = received; onLog(`  ${(received / 1024 ** 2).toFixed(0)} MB${total ? ` / ${(total / 1024 ** 2).toFixed(0)} MB` : ''}`); }
    }
  } finally { await handle.close(); }
  await fsp.rename(partial, target);
}
