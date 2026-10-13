// Smart reframe: follows where the motion is inside a shot so a vertical/square crop keeps
// the action in frame. Measured motion only (frame differences), not face or object recognition.
import { spawn } from 'node:child_process';
import { StudioError } from './paths.mjs';
import { findFfmpegTools } from './ffmpeg.mjs';

export const ASPECTS = Object.freeze({ '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '16:9': 16 / 9 });
const W = 96, H = 54;
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const r3 = n => Math.round(n * 1000) / 1000;
function median(values) { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

/** Decode a short window as tiny greyscale frames. */
export function decodeFrames(file, start, duration, { tools = findFfmpegTools(), fps } = {}) {
  const rate = fps ?? clamp(80 / Math.max(0.5, duration), 1, 8);
  return new Promise((resolve, reject) => {
    const child = spawn(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-ss', start.toFixed(3), '-t', duration.toFixed(3), '-protocol_whitelist', 'file,pipe', '-threads', '2', '-i', file,
      '-an', '-vf', `fps=${rate.toFixed(3)},scale=${W}:${H}:flags=area,format=gray`, '-f', 'rawvideo', 'pipe:1'], { windowsHide: true });
    const chunks = []; let size = 0, err = '';
    const timer = setTimeout(() => { child.kill(); reject(new StudioError('REFRAME_TIMEOUT', 'Reading the shot took too long.')); }, 120_000);
    child.stdout.on('data', c => { chunks.push(c); size += c.length; if (size > W * H * 2000) child.kill(); });
    child.stderr.on('data', c => { err = (err + c).slice(-1500); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      const buffer = Buffer.concat(chunks), frames = [];
      for (let o = 0; o + W * H <= buffer.length; o += W * H) frames.push(buffer.subarray(o, o + W * H));
      if (frames.length < 2) return reject(new StudioError('REFRAME_FAILED', `Too few frames to track motion. ${err.trim()}`.trim()));
      resolve({ frames, fps: rate });
    });
  });
}

/**
 * Motion centroid per frame pair. Camera motion moves every pixel, so only motion clearly above
 * the frame's own median counts; a light centre prior keeps noise from pulling to the edges.
 */
export function motionTrack(frames, fps = 4) {
  const track = [];
  const diff = new Float32Array(W * H);
  for (let f = 1; f < frames.length; f++) {
    const a = frames[f - 1], b = frames[f];
    const sorted = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) { diff[i] = Math.abs(b[i] - a[i]); sorted[i] = diff[i]; }
    sorted.sort();
    const threshold = Math.max(8, sorted[Math.floor(W * H * 0.5)] * 2.2, sorted[Math.floor(W * H * 0.8)]);
    let sw = 0, sx = 0, sy = 0;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const v = diff[y * W + x] - threshold;
      if (v <= 0) continue;
      const nx = x / (W - 1), ny = y / (H - 1);
      const w = v * (1 - 0.3 * Math.abs(nx - 0.5)) * (1 - 0.3 * Math.abs(ny - 0.5));
      sw += w; sx += w * nx; sy += w * ny;
    }
    const strength = sw / (W * H * 40);
    track.push({ t: f / fps, x: strength > 0.002 ? sx / sw : null, y: strength > 0.002 ? sy / sw : null, strength: r3(strength) });
  }
  // Fill gaps by holding the last known position, then a 5-sample moving median.
  let lx = null, ly = null;
  for (const p of track) { if (p.x == null) { p.x = lx; p.y = ly; p.held = true; } else { lx = p.x; ly = p.y; } }
  const known = track.filter(p => p.x != null);
  const fx = known[0]?.x ?? 0.5, fy = known[0]?.y ?? 0.5;
  for (const p of track) if (p.x == null) { p.x = fx; p.y = fy; }
  return track.map((p, i) => {
    const win = track.slice(Math.max(0, i - 2), i + 3);
    return { ...p, x: median(win.map(q => q.x)), y: median(win.map(q => q.y)) };
  });
}

/** Turn a centroid track into focus values for a crop of `outAspect` from a `srcAspect` source. */
export function focusFromTrack(track, srcAspect, outAspect, { follow = true } = {}) {
  const coverage = track.length ? track.filter(p => !p.held).length / track.length : 0;
  const winW = Math.min(1, outAspect / srcAspect), winH = Math.min(1, srcAspect / outAspect);
  const toFocus = (c, win) => (win >= 0.999 ? 0.5 : clamp((c - win / 2) / (1 - win)));
  const fx = track.map(p => toFocus(p.x, winW)), fy = track.map(p => toFocus(p.y, winH));
  const n = fx.length, head = Math.max(1, Math.round(n * 0.35));
  const solve = values => {
    const mid = median(values) ?? 0.5, a = median(values.slice(0, head)) ?? mid, b = median(values.slice(-head)) ?? mid;
    const staticErr = values.reduce((s, v) => s + Math.abs(v - mid), 0) / Math.max(1, n);
    const panErr = values.reduce((s, v, i) => { const p = n > 1 ? i / (n - 1) : 0; const e = p * p * (3 - 2 * p); return s + Math.abs(v - (a + (b - a) * e)); }, 0) / Math.max(1, n);
    if (follow && Math.abs(b - a) >= 0.12 && panErr < staticErr * 0.7) return { start: r3(a), end: r3(b), pan: true };
    return { start: r3(mid), end: r3(mid), pan: false };
  };
  const x = winW < 0.999 ? solve(fx) : { start: 0.5, end: 0.5, pan: false };
  const y = winH < 0.999 ? solve(fy) : { start: 0.5, end: 0.5, pan: false };
  return { focusX: x.start, focusXEnd: x.end, focusY: y.start, focusYEnd: y.end, pan: x.pan || y.pan, coverage: r3(coverage),
    confidence: coverage < 0.25 ? 'low' : coverage < 0.6 ? 'medium' : 'high' };
}

/** Operations that reframe clips; one `set` per clip. */
export function reframeOperations(results) {
  return results.filter(r => r.focus).map(r => ({ op: 'set', clip: r.id, framing: 'fill', focusX: r.focus.focusX, focusY: r.focus.focusY,
    focusXEnd: r.focus.focusXEnd, focusYEnd: r.focus.focusYEnd }));
}
