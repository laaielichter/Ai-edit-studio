// Music engine DSP: band-limited oscillators, filters, envelopes, effects, dynamics and loudness.
// Pure JavaScript on Float32Arrays at 48 kHz, deterministic (seeded noise), no dependencies.

export const SR = 48000;
export const TAU = Math.PI * 2;
export const midiHz = m => 440 * 2 ** ((m - 69) / 12);
export const dbGain = db => 10 ** (db / 20);
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Seeded PRNG (mulberry32): rnd() in [0,1). */
export function rng(seed = 1) {
  let a = (seed >>> 0) || 0x9e3779b9;
  const f = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  f.range = (lo, hi) => lo + (hi - lo) * f();
  f.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * f());
  f.pick = list => list[Math.floor(f() * list.length) % list.length];
  f.chance = p => f() < p;
  f.gauss = () => { let u = 0, v = 0; while (u === 0) u = f(); while (v === 0) v = f(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v); };
  return f;
}

export const stereo = n => ({ L: new Float32Array(n), R: new Float32Array(n) });
export const secs = s => Math.max(1, Math.round(s * SR));

/** Mix a mono or stereo buffer into a stereo destination at a sample offset with gain and constant-power pan. */
export function mixInto(dst, src, at, gain = 1, pan = 0) {
  const th = (clamp(pan, -1, 1) + 1) * Math.PI / 4, gl = Math.cos(th) * Math.SQRT2 * gain, gr = Math.sin(th) * Math.SQRT2 * gain;
  const n = dst.L.length, start = Math.max(0, at), off = start - at;
  if (src instanceof Float32Array) {
    const end = Math.min(n, at + src.length);
    for (let i = start; i < end; i++) { const v = src[i - at]; dst.L[i] += v * gl; dst.R[i] += v * gr; }
  } else {
    const end = Math.min(n, at + src.L.length);
    for (let i = start; i < end; i++) { dst.L[i] += src.L[i - at] * gl; dst.R[i] += src.R[i - at] * gr; }
  }
  return off;
}

// ------------------------------------------------------------------ oscillators
function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
/** One band-limited oscillator sample. type: saw | square | pulse | tri | sine. */
export function oscStep(state, inc, type, width = 0.5) {
  let p = state.p, y;
  if (type === 'sine') y = Math.sin(TAU * p);
  else if (type === 'saw') y = 2 * p - 1 - blep(p, inc);
  else {
    const w = type === 'pulse' ? width : 0.5;
    y = (p < w ? 1 : -1) + blep(p, inc) - blep((p - w + 1) % 1, inc);
    if (type === 'tri') { state.tri = (state.tri ?? 0) * 0.999 + y * 4 * inc; y = state.tri; }
  }
  p += inc; if (p >= 1) p -= 1;
  state.p = p;
  return y;
}

// ------------------------------------------------------------------ envelopes
/** ADSR as a Float32Array: attack (linear-ish curve), exponential decay to sustain, exponential release after gate. */
export function adsr(n, { a = 0.005, d = 0.2, s = 0.7, r = 0.2, gate, curve = 0.6 } = {}) {
  const env = new Float32Array(n), A = Math.max(1, a * SR), D = Math.max(1, d * SR), R = Math.max(1, r * SR);
  const G = gate === undefined ? n : Math.min(n, Math.round(gate * SR));
  let v = 0;
  for (let i = 0; i < G; i++) {
    if (i < A) { const x = i / A; v = curve > 0 ? 1 - (1 - x) ** (1 + curve * 2) : x; }
    else v = s + (1 - s) * Math.exp(-(i - A) / (D / 4.6));
    env[i] = v;
  }
  const atGate = v;
  for (let i = G; i < n; i++) env[i] = atGate * Math.exp(-(i - G) / (R / 4.6));
  return env;
}
/** Exponential decay envelope with a short attack: punchy percussive shapes. */
export function decayEnv(n, tau, attack = 0.001, hold = 0) {
  const env = new Float32Array(n), A = Math.max(1, attack * SR), H = hold * SR, T = tau * SR;
  for (let i = 0; i < n; i++) env[i] = i < A ? i / A : i < A + H ? 1 : Math.exp(-(i - A - H) / T);
  return env;
}
export function fadeEdges(buf, inS = 0.002, outS = 0.01) {
  const arrs = buf instanceof Float32Array ? [buf] : [buf.L, buf.R];
  for (const x of arrs) {
    const a = Math.min(x.length, Math.round(inS * SR)), b = Math.min(x.length, Math.round(outS * SR));
    for (let i = 0; i < a; i++) x[i] *= i / a;
    for (let i = 0; i < b; i++) x[x.length - 1 - i] *= i / b;
  }
  return buf;
}

// ------------------------------------------------------------------ noise
export function whiteNoise(n, rnd) { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = rnd() * 2 - 1; return x; }
export function pinkNoise(n, rnd) {
  const x = new Float32Array(n); let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = rnd() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    x[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
  }
  return x;
}

// ------------------------------------------------------------------ filters
/** Zero-delay-feedback state-variable filter (Simper/Zavalishin): stable under fast cutoff modulation. */
export class SVF {
  constructor() { this.ic1 = 0; this.ic2 = 0; this.set(1000, 0.707); }
  set(cutoff, q = 0.707) {
    const g = Math.tan(Math.PI * clamp(cutoff, 10, SR * 0.47) / SR), k = 1 / Math.max(0.3, q);
    this.k = k; this.a1 = 1 / (1 + g * (g + k)); this.a2 = g * this.a1; this.a3 = g * this.a2;
  }
  tick(v0) {
    const v3 = v0 - this.ic2, v1 = this.a1 * this.ic1 + this.a2 * v3, v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    this.low = v2; this.band = v1; this.high = v0 - this.k * v1 - v2;
    return v2;
  }
}
/** Filter a buffer in place with a static or per-sample cutoff function (updated every 16 samples). */
export function svfProcess(x, { type = 'lp', cutoff = 1000, q = 0.707, poles = 2 } = {}) {
  const stages = poles >= 4 ? [new SVF(), new SVF()] : [new SVF()];
  const dyn = typeof cutoff === 'function';
  for (const s of stages) s.set(dyn ? cutoff(0) : cutoff, poles >= 4 ? Math.min(q, 0.9) : q);
  for (let i = 0; i < x.length; i++) {
    if (dyn && (i & 15) === 0) { const c = cutoff(i / SR); for (const s of stages) s.set(c, poles >= 4 ? Math.min(q, 0.9) : q); }
    let v = x[i];
    for (const s of stages) { s.tick(v); v = type === 'lp' ? s.low : type === 'hp' ? s.high : type === 'bp' ? s.band : s.low + s.high; }
    x[i] = v;
  }
  return x;
}
/** RBJ cookbook biquad (transposed direct form II). */
export class Biquad {
  constructor(type, f, q = 0.707, gainDb = 0) {
    const A = 10 ** (gainDb / 40), w = TAU * clamp(f, 10, SR * 0.48) / SR, cw = Math.cos(w), sw = Math.sin(w), al = sw / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
    else if (type === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
    else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
    else if (type === 'peak') { b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; }
    else if (type === 'lowshelf') { const s = 2 * Math.sqrt(A) * al; b0 = A * ((A + 1) - (A - 1) * cw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - s); a0 = (A + 1) + (A - 1) * cw + s; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - s; }
    else if (type === 'highshelf') { const s = 2 * Math.sqrt(A) * al; b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s); a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s; }
    else throw new Error(`biquad type ${type}`);
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0; this.z1 = 0; this.z2 = 0;
  }
  tick(x) { const y = this.b0 * x + this.z1; this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y; return y; }
  run(x) { for (let i = 0; i < x.length; i++) x[i] = this.tick(x[i]); return x; }
}
/** Apply an EQ chain [[type, f, q, gain], ...] to a stereo buffer in place. */
export function eq(buf, bands) {
  for (const ch of [buf.L, buf.R]) for (const [t, f, q, g] of bands) new Biquad(t, f, q ?? 0.707, g ?? 0).run(ch);
  return buf;
}

// ------------------------------------------------------------------ distortion
export function saturate(x, drive = 1.5, mix = 1) {
  const norm = Math.tanh(drive);
  for (let i = 0; i < x.length; i++) { const d = Math.tanh(x[i] * drive) / norm; x[i] = x[i] + (d - x[i]) * mix; }
  return x;
}

// ------------------------------------------------------------------ modulation and space
/** Stereo chorus: two modulated delay taps in counter-phase. */
export function chorus(buf, { rate = 0.35, depth = 0.003, base = 0.012, mix = 0.45 } = {}) {
  const n = buf.L.length, size = secs(base + depth * 2 + 0.01), dl = new Float32Array(size), dr = new Float32Array(size);
  let w = 0;
  for (let i = 0; i < n; i++) {
    const l = buf.L[i], r = buf.R[i];
    dl[w] = l; dr[w] = r;
    const ph = TAU * rate * i / SR;
    const tl = (base + depth * Math.sin(ph)) * SR, tr = (base + depth * Math.sin(ph + Math.PI)) * SR;
    const rl = read(dl, w - tl, size), rr = read(dr, w - tr, size);
    buf.L[i] = l * (1 - mix * 0.5) + rr * mix; buf.R[i] = r * (1 - mix * 0.5) + rl * mix;
    w = (w + 1) % size;
  }
  return buf;
}
function read(arr, pos, size) { pos = ((pos % size) + size) % size; const i = Math.floor(pos), f = pos - i; return arr[i] * (1 - f) + arr[(i + 1) % size] * f; }

/** Tempo-synced ping-pong delay with filtered feedback; returns the wet signal only. */
export function pingPong(buf, { time = 0.375, feedback = 0.38, hp = 350, lp = 4500 } = {}) {
  const n = buf.L.length, d = secs(time), out = stereo(n), bl = new Float32Array(d), br = new Float32Array(d);
  const lpL = new Biquad('lp', lp), lpR = new Biquad('lp', lp), hpL = new Biquad('hp', hp), hpR = new Biquad('hp', hp);
  let w = 0;
  for (let i = 0; i < n; i++) {
    const yl = bl[w], yr = br[w];
    out.L[i] = yl; out.R[i] = yr;
    const inMono = (buf.L[i] + buf.R[i]) * 0.5;
    bl[w] = hpL.tick(lpL.tick(inMono + yr * feedback));
    br[w] = hpR.tick(lpR.tick(yl * feedback));
    w = (w + 1) % d;
  }
  return out;
}

/** 8-line feedback delay network reverb (Hadamard mixing, damping, modulation, pre-delay); returns wet only. */
export function reverb(buf, { decay = 2.2, size = 1, damp = 6500, pre = 0.02, hp = 220, width = 1 } = {}) {
  const n = buf.L.length, tail = secs(decay * 1.2), N = n + tail, out = stereo(N);
  const lens = [1031, 1327, 1523, 1801, 2053, 2381, 2713, 3083].map(l => Math.round(l * size));
  const lines = lens.map(l => new Float32Array(l + 8)), pos = new Int32Array(8);
  const gains = lens.map(l => 10 ** (-3 * l / (decay * SR)));
  const dampCoef = Math.exp(-TAU * damp / SR), lpState = new Float64Array(8);
  // input diffusion: 4 allpasses
  const apL = [142, 107, 379, 277].map(l => ({ b: new Float32Array(Math.round(l * size)), i: 0 })), apR = [151, 113, 389, 293].map(l => ({ b: new Float32Array(Math.round(l * size)), i: 0 }));
  const ap = (s, x, g = 0.62) => { const y = s.b[s.i]; const v = x + y * g; s.b[s.i] = v; s.i = (s.i + 1) % s.b.length; return y - v * g; };
  const preN = secs(pre), preL = new Float32Array(preN + 1), preR = new Float32Array(preN + 1); let pw = 0;
  const hpL = new Biquad('hp', hp), hpR = new Biquad('hp', hp);
  const v = new Float64Array(8);
  for (let i = 0; i < N; i++) {
    let il = i < n ? buf.L[i] : 0, ir = i < n ? buf.R[i] : 0;
    const dl = preL[pw], dr = preR[pw]; preL[pw] = il; preR[pw] = ir; pw = (pw + 1) % preL.length;
    let xl = hpL.tick(dl), xr = hpR.tick(dr);
    for (const s of apL) xl = ap(s, xl); for (const s of apR) xr = ap(s, xr);
    // read lines (two of them slowly modulated against metallic ringing)
    for (let k = 0; k < 8; k++) {
      const len = lens[k];
      let y;
      if (k === 2 || k === 5) {
        const m = 6 * Math.sin(TAU * (0.31 + k * 0.07) * i / SR);
        const p = pos[k] - len + m; const L = lines[k].length; const q = ((p % L) + L) % L; const j = Math.floor(q), f = q - j;
        y = lines[k][j] * (1 - f) + lines[k][(j + 1) % L] * f;
      } else y = lines[k][(pos[k] - len + lines[k].length) % lines[k].length];
      lpState[k] = y * (1 - dampCoef) + lpState[k] * dampCoef;
      v[k] = lpState[k] * gains[k];
    }
    // fast Walsh-Hadamard (orthogonal mixing)
    for (let h = 1; h < 8; h *= 2) for (let a = 0; a < 8; a += h * 2) for (let b = a; b < a + h; b++) { const x = v[b], y = v[b + h]; v[b] = x + y; v[b + h] = x - y; }
    const s8 = 1 / Math.sqrt(8);
    for (let k = 0; k < 8; k++) {
      const inj = k % 2 === 0 ? xl : xr;
      lines[k][pos[k]] = v[k] * s8 + inj * 0.35;
      pos[k] = (pos[k] + 1) % lines[k].length;
    }
    const ol = (v[0] - v[3] + v[4] - v[7] + v[2]) * s8, or = (v[1] - v[2] + v[5] - v[6] + v[3]) * s8;
    const mid = (ol + or) * 0.5, side = (ol - or) * 0.5 * width;
    out.L[i] = mid + side; out.R[i] = mid - side;
  }
  return out;
}

// ------------------------------------------------------------------ dynamics
/** Feed-forward stereo-linked compressor; optional key (sidechain) buffer. */
export function compress(buf, { threshold = -18, ratio = 3, attack = 0.01, release = 0.12, knee = 6, makeup = 0, key } = {}) {
  const n = buf.L.length, at = Math.exp(-1 / (attack * SR)), rt = Math.exp(-1 / (release * SR));
  let env = -120;
  for (let i = 0; i < n; i++) {
    const kx = key ? Math.max(Math.abs(key.L[i] ?? 0), Math.abs(key.R[i] ?? 0)) : Math.max(Math.abs(buf.L[i]), Math.abs(buf.R[i]));
    const db = 20 * Math.log10(kx + 1e-9);
    env = db > env ? at * env + (1 - at) * db : rt * env + (1 - rt) * db;
    const over = env - threshold;
    let gr = 0;
    if (over > knee / 2) gr = over * (1 - 1 / ratio);
    else if (over > -knee / 2) gr = (1 - 1 / ratio) * (over + knee / 2) ** 2 / (2 * knee);
    const g = 10 ** ((makeup - gr) / 20);
    buf.L[i] *= g; buf.R[i] *= g;
  }
  return buf;
}
/** Look-ahead brickwall limiter (instant attack inside the look-ahead, smooth release) + safety clip. */
export function limit(buf, { ceiling = -1, lookahead = 0.003, release = 0.08 } = {}) {
  const n = buf.L.length, la = secs(lookahead), c = dbGain(ceiling), rel = Math.exp(-1 / (release * SR));
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = Math.max(Math.abs(buf.L[i]), Math.abs(buf.R[i])); need[i] = p > c ? c / p : 1; }
  // sliding minimum over the look-ahead window (monotonic deque)
  const minAhead = new Float32Array(n), dq = new Int32Array(n); let h = 0, t = 0;
  for (let i = n - 1; i >= 0; i--) {
    while (t > h && need[dq[t - 1]] >= need[i]) t--;
    dq[t++] = i;
    while (dq[h] > i + la) h++;
    minAhead[i] = need[dq[h]];
  }
  let g = 1;
  for (let i = 0; i < n; i++) {
    const target = minAhead[i];
    g = target < g ? target : target + (g - target) * rel;
    const l = buf.L[i] * g, r = buf.R[i] * g;
    buf.L[i] = Math.max(-c, Math.min(c, l)); buf.R[i] = Math.max(-c, Math.min(c, r));
  }
  return buf;
}
/** Volume-shaper sidechain: duck at every trigger time, recover with a smooth curve (classic EDM pump). */
export function pump(buf, times, { depth = 0.6, release = 0.22, attack = 0.004 } = {}) {
  const n = buf.L.length, g = new Float32Array(n).fill(1), R = release * SR, A = attack * SR;
  for (const t of times) {
    const s = Math.round(t * SR);
    for (let i = Math.max(0, Math.round(s - A)); i < Math.min(n, s + R); i++) {
      let shape;
      if (i < s) shape = 1 - depth * (1 - (s - i) / A); // fast duck just before the hit
      else {
        const x = (i - s) / R, hold = 0.08, y = x < hold ? 0 : (x - hold) / (1 - hold);
        shape = 1 - depth * (1 - y * y * (3 - 2 * y)); // hold, then an S-curve back up
      }
      if (shape < g[i]) g[i] = shape;
    }
  }
  for (let i = 0; i < n; i++) { buf.L[i] *= g[i]; buf.R[i] *= g[i]; }
  return buf;
}
export function stereoWidth(buf, width = 1) {
  for (let i = 0; i < buf.L.length; i++) { const m = (buf.L[i] + buf.R[i]) * 0.5, s = (buf.L[i] - buf.R[i]) * 0.5 * width; buf.L[i] = m + s; buf.R[i] = m - s; }
  return buf;
}
export function gain(buf, g) { for (let i = 0; i < buf.L.length; i++) { buf.L[i] *= g; buf.R[i] *= g; } return buf; }
export function addInto(dst, src, g = 1, at = 0) {
  const end = Math.min(dst.L.length, at + src.L.length);
  for (let i = Math.max(0, at); i < end; i++) { dst.L[i] += src.L[i - at] * g; dst.R[i] += src.R[i - at] * g; }
  return dst;
}

// ------------------------------------------------------------------ measurement
/** Integrated loudness (ITU-R BS.1770-4, K-weighted, gated) of a 48 kHz stereo buffer. */
export function lufs(buf) {
  const k = ch => { const s1 = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [-1.69065929318241, 0.73248077421585] }, s2 = { b: [1, -2, 1], a: [-1.99004745483398, 0.99007225036621] };
    const out = new Float64Array(ch.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, z1 = 0, z2 = 0;
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i], y = s1.b[0] * x + s1.b[1] * x1 + s1.b[2] * x2 - s1.a[0] * y1 - s1.a[1] * y2; x2 = x1; x1 = x; y2 = y1; y1 = y;
      const z = s2.b[0] * y + s2.b[1] * u1 + s2.b[2] * u2 - s2.a[0] * z1 - s2.a[1] * z2; u2 = u1; u1 = y; z2 = z1; z1 = z; out[i] = z * z;
    }
    return out; };
  const l = k(buf.L), r = k(buf.R), block = Math.round(0.4 * SR), step = Math.round(0.1 * SR), blocks = [];
  const cl = new Float64Array(l.length + 1), cr = new Float64Array(r.length + 1);
  for (let i = 0; i < l.length; i++) { cl[i + 1] = cl[i] + l[i]; cr[i + 1] = cr[i] + r[i]; }
  for (let s = 0; s + block <= l.length; s += step) blocks.push(((cl[s + block] - cl[s]) + (cr[s + block] - cr[s])) / block);
  const loud = z => -0.691 + 10 * Math.log10(z + 1e-12);
  const abs = blocks.filter(z => loud(z) > -70);
  if (!abs.length) return -70;
  const rel = loud(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter(z => loud(z) > rel);
  return loud(gated.reduce((a, b) => a + b, 0) / gated.length);
}
export function peakDb(buf) { let p = 0; for (let i = 0; i < buf.L.length; i++) p = Math.max(p, Math.abs(buf.L[i]), Math.abs(buf.R[i])); return 20 * Math.log10(p + 1e-12); }

// ------------------------------------------------------------------ files
/** 24-bit PCM WAV (stereo, 48 kHz) as a Buffer. */
export function wav24(buf) {
  const n = buf.L.length, data = Buffer.alloc(n * 6), h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 6, 28); h.writeUInt16LE(6, 32); h.writeUInt16LE(24, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  for (let i = 0, o = 0; i < n; i++) for (const ch of [buf.L, buf.R]) { const v = Math.max(-8388608, Math.min(8388607, Math.round(ch[i] * 8388607))); data.writeIntLE(v, o, 3); o += 3; }
  return Buffer.concat([h, data]);
}

// ------------------------------------------------------------------ tonal balance
export const OCTAVES = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
/** In-place iterative radix-2 FFT on (re, im) Float64Arrays of a power-of-two length. */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j], ai = im[i + j], br = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci, bi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ar + br; im[i + j] = ai + bi; re[i + j + len / 2] = ar - br; im[i + j + len / 2] = ai - bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
/** Octave-band energy (dB) of the mid signal: long-term average spectrum (Hann-windowed FFT frames). */
export function bandLevels(buf, { from = 0, to } = {}) {
  const N = 8192, hop = 4096, a = Math.round(from * SR), b = Math.min(buf.L.length, to === undefined ? buf.L.length : Math.round(to * SR));
  const power = new Float64Array(N / 2 + 1), win = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(TAU * i / (N - 1)));
  const re = new Float64Array(N), im = new Float64Array(N);
  let frames = 0;
  for (let s = a; s + N <= b; s += hop) {
    for (let i = 0; i < N; i++) { re[i] = (buf.L[s + i] + buf.R[s + i]) * 0.5 * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= N / 2; k++) power[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  return OCTAVES.map(f => {
    const lo = Math.max(1, Math.floor(f / Math.SQRT2 * N / SR)), hi = Math.min(N / 2, Math.ceil(f * Math.SQRT2 * N / SR));
    let e = 0; for (let k = lo; k < hi; k++) e += power[k];
    return 10 * Math.log10(e / Math.max(1, frames) + 1e-20);
  });
}
/**
 * Nudge the octave-band balance toward a target curve (relative dB per OCTAVES band) with gentle peaking EQ:
 * only the SHAPE is corrected (overall level is kept), and only partly, so a style keeps its own colour.
 */
export function tonalBalance(buf, target, { amount = 0.6, max = 5, passes = 2, from = 0, to } = {}) {
  const applied = OCTAVES.map(() => 0);
  for (let p = 0; p < passes; p++) {
    const lv = bandLevels(buf, { from, to });
    const diffs = lv.map((l, k) => target[k] - l);
    const mid = diffs.slice(2, 8), offset = mid.reduce((s, d) => s + d, 0) / mid.length;
    const bands = [];
    diffs.forEach((d, k) => {
      let g = (d - offset) * amount * (p ? 0.5 : 1);
      // never more than ±max in total per band (boosts a bit less than cuts)
      g = Math.max(-max - applied[k], Math.min((k === 0 ? 0 : max * 0.8) - applied[k], g)); // the deep-sub band is only ever cut
      if (Math.abs(g) < 0.4) return;
      applied[k] += g;
      const f = OCTAVES[k];
      bands.push(k === 0 ? ['lowshelf', 45, 0.7, g] : k === OCTAVES.length - 1 ? ['highshelf', 12000, 0.7, g] : ['peak', f, 1.1, g]);
    });
    eq(buf, bands);
  }
  return applied.map(g => Math.round(g * 10) / 10);
}
