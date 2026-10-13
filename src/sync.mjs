// Audio sync between recordings (multicam, separate audio recorder): onset envelopes at 100 Hz,
// cross-correlated with an FFT. Returns how many seconds later each source started than the reference.
import { spawn } from 'node:child_process';
import { StudioError } from './paths.mjs';
import { findFfmpegTools } from './ffmpeg.mjs';

const RATE = 4000, HOP = 40; // 100 envelope values per second

/** Mono 4 kHz decode of the first `seconds` (from `start`). */
export function decodeEnvelope(file, { start = 0, seconds = 600, tools = findFfmpegTools() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-ss', String(start), '-t', String(seconds), '-protocol_whitelist', 'file,pipe', '-i', file,
      '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], { windowsHide: true });
    const chunks = []; let size = 0, err = '';
    const timer = setTimeout(() => { child.kill(); reject(new StudioError('SYNC_TIMEOUT', 'Reading the audio took too long.')); }, 10 * 60_000);
    child.stdout.on('data', c => { chunks.push(c); size += c.length; });
    child.stderr.on('data', c => { err = (err + c).slice(-1500); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks), n = Math.floor(buf.length / 2 / HOP);
      if (n < 200) return reject(new StudioError('SYNC_NO_AUDIO', `Too little audio to sync. ${err.trim()}`.trim()));
      const env = new Float64Array(n);
      for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < HOP; k++) s += Math.abs(buf.readInt16LE((i * HOP + k) * 2)); env[i] = s / HOP; }
      resolve(env);
    });
  });
}

/** Positive log-energy flux, zero mean, unit variance: robust to different gains and mics. */
export function onsets(env) {
  const out = new Float64Array(env.length);
  for (let i = 1; i < env.length; i++) out[i] = Math.max(0, Math.log(env[i] + 1) - Math.log(env[i - 1] + 1));
  let mean = 0; for (const v of out) mean += v; mean /= out.length;
  let sd = 0; for (const v of out) sd += (v - mean) ** 2; sd = Math.sqrt(sd / out.length) || 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - mean) / sd;
  return out;
}

function fft(re, im, invert = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = 2 * Math.PI / len * (invert ? -1 : 1), wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j], ai = im[i + j], br = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci, bi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ar + br; im[i + j] = ai + bi; re[i + j + len / 2] = ar - br; im[i + j + len / 2] = ai - bi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (invert) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/**
 * Offset (s) such that source time = reference time − offset, i.e. how much later the source started.
 * confidence: peak height over the next-best peak (≥ 1.5 is reliable).
 */
export function correlate(ref, sig, { maxOffset = 300 } = {}) {
  const n = 1 << Math.ceil(Math.log2(ref.length + sig.length));
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(ref); br.set(sig);
  fft(ar, ai); fft(br, bi);
  for (let i = 0; i < n; i++) { const r = ar[i] * br[i] + ai[i] * bi[i], im = ai[i] * br[i] - ar[i] * bi[i]; ar[i] = r; ai[i] = im; }
  fft(ar, ai, true);
  // ar[k] = Σ ref[t + k] · sig[t]: a peak at k means sig[t] matches ref[t + k] → source started k later.
  const L = Math.min(Math.round(maxOffset * 100), n / 2 - 1);
  let best = 0, bestV = -Infinity;
  const value = k => ar[(k + n) % n];
  for (let k = -L; k <= L; k++) { const v = value(k); if (v > bestV) { bestV = v; best = k; } }
  let second = -Infinity;
  for (let k = -L; k <= L; k++) if (Math.abs(k - best) > 50) second = Math.max(second, value(k));
  return { offset: Math.round(best) / 100, confidence: Math.round(100 * bestV / Math.max(1e-9, second)) / 100 };
}

export async function syncSources(files, { reference = 0, seconds = 600, maxOffset = 300, tools } = {}) {
  const envs = [];
  for (const file of files) envs.push(file ? onsets(await decodeEnvelope(file, { seconds, tools })) : null);
  const ref = envs[reference];
  if (!ref) throw new StudioError('SYNC_NO_AUDIO', 'The reference source has no audio.');
  return envs.map((env, i) => (i === reference ? { offset: 0, confidence: null, reference: true } : env ? correlate(ref, env, { maxOffset }) : null));
}
