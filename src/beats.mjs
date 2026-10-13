// Local music beat detection: spectral-flux onsets, autocorrelation tempo and
// dynamic-programming beat tracking (after Ellis 2007). No model, no network.
import { spawn } from 'node:child_process';
import { findFfmpegTools } from './ffmpeg.mjs';
import { StudioError } from './paths.mjs';

const RATE = 22050, WINDOW = 1024, HOP = 512;

export async function decodeMono(file, { tools = findFfmpegTools(), maxSeconds = 600 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', file,
      '-t', String(maxSeconds), '-vn', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', 'pipe:1'], { windowsHide: true });
    const chunks = []; let size = 0, stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new StudioError('BEAT_TIMEOUT', 'Music analysis took too long.')); }, 120_000);
    child.stdout.on('data', c => { chunks.push(c); size += c.length; if (size > RATE * 4 * (maxSeconds + 5)) child.kill(); });
    child.stderr.on('data', c => { stderr = (stderr + c).slice(-2000); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 && !size) return reject(new StudioError('INVALID_AUDIO', `Music could not be read. ${stderr.trim()}`.trim()));
      const buffer = Buffer.concat(chunks);
      const samples = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 4));
      resolve(Float32Array.from(samples));
    });
  });
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = -2 * Math.PI / len, wr = Math.cos(angle), wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/** Onset strength envelope, one value per HOP samples. */
export function onsetEnvelope(samples) {
  const frames = Math.max(0, Math.floor((samples.length - WINDOW) / HOP) + 1);
  const hann = Float64Array.from({ length: WINDOW }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (WINDOW - 1)));
  const bins = WINDOW / 2;
  let previous = new Float64Array(bins);
  const env = new Float64Array(frames);
  const re = new Float64Array(WINDOW), im = new Float64Array(WINDOW);
  for (let f = 0; f < frames; f++) {
    const offset = f * HOP;
    for (let i = 0; i < WINDOW; i++) { re[i] = samples[offset + i] * hann[i]; im[i] = 0; }
    fft(re, im);
    const current = new Float64Array(bins);
    let flux = 0;
    for (let k = 1; k < bins; k++) {
      current[k] = Math.log1p(1000 * Math.hypot(re[k], im[k]));
      const d = current[k] - previous[k];
      if (d > 0) flux += d;
    }
    env[f] = flux; previous = current;
  }
  // Remove slow trend and normalise.
  const out = new Float64Array(frames), radius = 8;
  for (let i = 0; i < frames; i++) {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(frames - 1, i + radius); j++) { sum += env[j]; count++; }
    out[i] = Math.max(0, env[i] - sum / count);
  }
  let mean = 0; for (const v of out) mean += v; mean /= Math.max(1, frames);
  let sd = 0; for (const v of out) sd += (v - mean) ** 2; sd = Math.sqrt(sd / Math.max(1, frames)) || 1;
  return out.map(v => v / sd);
}

export function estimateTempo(env, { min = 70, max = 180, prior = 120 } = {}) {
  const fps = RATE / HOP;
  const minLag = Math.floor(fps * 60 / max), maxLag = Math.ceil(fps * 60 / min);
  const scores = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = lag; i < env.length; i++) sum += env[i] * env[i - lag];
    const bpm = fps * 60 / lag;
    const weight = Math.exp(-0.5 * (Math.log2(bpm / prior) / 0.9) ** 2);
    scores.push({ lag, raw: sum / Math.max(1, env.length - lag), score: weight * sum / Math.max(1, env.length - lag) });
  }
  if (!scores.length) return { bpm: 0, period: 0, confidence: 0 };
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  const byLag = new Map(scores.map(s => [s.lag, s.score]));
  const l = byLag.get(best.lag - 1) ?? best.score, r = byLag.get(best.lag + 1) ?? best.score;
  const denom = l - 2 * best.score + r;
  const lag = denom ? best.lag + 0.5 * (l - r) / denom : best.lag;
  const median = scores[Math.floor(scores.length / 2)].score || 1e-9;
  return { bpm: fps * 60 / lag, period: lag, confidence: Math.max(0, Math.min(1, (best.score / median - 1) / 4)) };
}

export function trackBeats(env, period, tightness = 100) {
  const n = env.length;
  if (!n || !period) return [];
  const score = new Float64Array(n), back = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let best = -Infinity, arg = -1;
    for (let p = Math.max(0, Math.round(i - 2 * period)); p <= i - Math.round(period / 2); p++) {
      const s = score[p] - tightness * Math.log((i - p) / period) ** 2;
      if (s > best) { best = s; arg = p; }
    }
    score[i] = env[i] + (arg >= 0 ? Math.max(0, best) : 0);
    back[i] = arg >= 0 && best > 0 ? arg : -1;
  }
  // Start from the best-scoring frame in the final period.
  let i = n - 1, top = -Infinity;
  for (let j = Math.max(0, Math.floor(n - period)); j < n; j++) if (score[j] > top) { top = score[j]; i = j; }
  const beats = [];
  while (i >= 0) { beats.push(i); i = back[i]; }
  return beats.reverse().map(f => (f * HOP + WINDOW / 2) / RATE);
}

/** Full analysis of a decoded mono signal. */
export function analyzeBeats(samples) {
  const duration = samples.length / RATE;
  if (duration < 3) throw new StudioError('MUSIC_TOO_SHORT', 'Music must be at least 3 seconds long for beat detection.');
  const env = onsetEnvelope(samples);
  const tempo = estimateTempo(env);
  const beats = trackBeats(env, tempo.period).map(t => Math.round(t * 1000) / 1000);
  // Strongest onset among the first four beats acts as downbeat guess.
  const fps = RATE / HOP;
  let downbeat = 0, strongest = -Infinity;
  for (let k = 0; k < Math.min(4, beats.length); k++) {
    let s = 0; for (let j = k; j < beats.length; j += 4) s += env[Math.round(beats[j] * fps - WINDOW / 2 / HOP)] ?? 0;
    if (s > strongest) { strongest = s; downbeat = k; }
  }
  return {
    schemaVersion: 1, duration: Math.round(duration * 1000) / 1000,
    bpm: Math.round(tempo.bpm * 10) / 10, confidence: Math.round(tempo.confidence * 100) / 100,
    beats, downbeatIndex: downbeat,
    note: 'Local signal analysis; no musical understanding. Check by ear.',
  };
}

export async function analyzeMusicFile(file, options = {}) {
  return analyzeBeats(await decodeMono(file, options));
}

/** Beats as timeline times, given where the music starts in the file. */
export function timelineBeats(analysis, musicTrimStart = 0, editDuration = 120) {
  if (!analysis?.beats?.length) return [];
  const out = [];
  const loop = analysis.duration;
  // Music is looped by the renderer: repeat the beat grid to cover the edit.
  for (let offset = 0; offset - musicTrimStart < editDuration + 1 && out.length < 6000; offset += loop) {
    for (const b of analysis.beats) {
      const t = b + offset - musicTrimStart;
      if (t >= 0 && t <= editDuration + 0.5) out.push(Math.round(t * 1000) / 1000);
    }
    if (loop <= 0) break;
  }
  return out;
}
