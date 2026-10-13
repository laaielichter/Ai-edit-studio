// Music engine instruments: synthesised drums, basses, keys, pads, leads and transition effects.
// Every sound is made from oscillators and noise here (no samples), so the music is free of third-party rights.
import { SR, TAU, secs, clamp, oscStep, adsr, decayEnv, whiteNoise, pinkNoise, SVF, Biquad, saturate, svfProcess, fadeEdges, stereo } from './dsp.mjs';

const hp = (x, f, q) => new Biquad('hp', f, q).run(x);
const lp = (x, f, q) => new Biquad('lp', f, q).run(x);
const bp = (x, f, q) => new Biquad('bp', f, q).run(x);
const peak = (x, f, q, g) => new Biquad('peak', f, q, g).run(x);
const norm = (x, to = 0.9) => { let p = 0; for (const v of x) p = Math.max(p, Math.abs(v)); if (p > 0) for (let i = 0; i < x.length; i++) x[i] *= to / p; return x; };
const normS = (b, to = 0.9) => { let p = 0; for (let i = 0; i < b.L.length; i++) p = Math.max(p, Math.abs(b.L[i]), Math.abs(b.R[i])); if (p > 0) { const g = to / p; for (let i = 0; i < b.L.length; i++) { b.L[i] *= g; b.R[i] *= g; } } return b; };

// ------------------------------------------------------------------ generic subtractive voice
/**
 * Polyphony is handled by the arranger; this renders ONE note with unison voices, stereo spread,
 * filter + amp envelopes, pitch envelope, glide and vibrato.
 */
export function synth(o, rnd) {
  const amp = { a: 0.005, d: 0.3, s: 0.7, r: 0.15, ...o.amp };
  const n = secs(o.dur + amp.r + 0.03), base = new Float32Array(n);
  const vib = o.vibrato, glide = o.glide, pitch = o.pitch;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let f = o.freq;
    if (glide && t < glide.time) f = glide.from * (o.freq / glide.from) ** (t / glide.time);
    if (pitch) f *= 2 ** ((pitch.semis * Math.exp(-t / pitch.time)) / 12);
    if (vib && t > (vib.delay ?? 0)) f *= 2 ** ((vib.cents * Math.min(1, (t - (vib.delay ?? 0)) / 0.3) * Math.sin(TAU * vib.rate * t)) / 1200);
    base[i] = f;
  }
  const L = new Float32Array(n), R = new Float32Array(n);
  const layers = o.waves ?? [{ type: 'saw', gain: 1 }];
  const U = o.unison?.voices ?? 1, det = o.unison?.detune ?? 0, spread = o.unison?.spread ?? 0, blend = o.unison?.blend ?? 0.7;
  let total = 0;
  for (const w of layers) {
    const vs = w.unison === false ? 1 : U;
    for (let u = 0; u < vs; u++) {
      const pos = vs === 1 ? 0 : (u / (vs - 1)) * 2 - 1; // -1..1
      const cents = (w.detune ?? 0) + det * pos * (0.85 + 0.3 * rnd()) + (w.octave ?? 0) * 1200;
      const ratio = 2 ** (cents / 1200), g = (w.gain ?? 1) * (vs === 1 || Math.abs(pos) < 0.01 ? 1 : blend);
      const pan = vs === 1 ? 0 : spread * (u % 2 ? -1 : 1) * Math.abs(pos);
      const th = (pan + 1) * Math.PI / 4, gl = Math.cos(th) * Math.SQRT2 * g, gr = Math.sin(th) * Math.SQRT2 * g;
      const st = { p: o.phaseReset ? 0 : rnd() };
      for (let i = 0; i < n; i++) { const y = oscStep(st, base[i] * ratio / SR, w.type, w.width); L[i] += y * gl; R[i] += y * gr; }
      total += g;
    }
  }
  const sc = 1 / Math.max(1, Math.sqrt(total) * 1.2);
  const fe = o.filter;
  if (fe) {
    const fenv = fe.env ? adsr(n, { ...fe.env, gate: o.dur }) : null;
    const key = fe.keytrack ? (o.freq / 261.6) ** fe.keytrack : 1;
    const fl = new SVF(), fr = new SVF(), fl2 = new SVF(), fr2 = new SVF(), four = fe.poles === 4;
    for (let i = 0; i < n; i++) {
      if ((i & 15) === 0) {
        const c = clamp(fe.cutoff * key * 2 ** ((fe.envAmt ?? 0) * (fenv ? fenv[i] : 0)) * (fe.lfo ? 2 ** (fe.lfo.depth * Math.sin(TAU * fe.lfo.rate * i / SR + (fe.lfo.phase ?? 0))) : 1), 20, 20000);
        fl.set(c, fe.q ?? 0.8); fr.set(c, fe.q ?? 0.8); if (four) { fl2.set(c, 0.6); fr2.set(c, 0.6); }
      }
      let l = fl.tick(L[i]), r = fr.tick(R[i]);
      if (four) { l = fl2.tick(l); r = fr2.tick(r); }
      L[i] = l; R[i] = r;
    }
  }
  const env = adsr(n, { ...amp, gate: o.dur });
  for (let i = 0; i < n; i++) { L[i] *= env[i] * sc; R[i] *= env[i] * sc; }
  if (o.drive) { saturate(L, o.drive); saturate(R, o.drive); }
  return fadeEdges({ L, R }, 0.0005, 0.004);
}

// ------------------------------------------------------------------ drums
export function kick(rnd, { tone = 50, punch = 1, decay = 0.28, click = 1, drive = 1.6, start = 230 } = {}) {
  const n = secs(decay * 2.2 + 0.05), x = new Float32Array(n), st = { p: 0.25 };
  for (let i = 0; i < n; i++) {
    const t = i / SR, f = tone + (start - tone) * Math.exp(-t / (0.03 * punch));
    x[i] = oscStep(st, f / SR, 'sine') * (t < 0.0006 ? t / 0.0006 : Math.exp(-Math.max(0, t - 0.03) / decay));
  }
  saturate(x, drive);
  const c = hp(whiteNoise(secs(0.012), rnd), 2500, 0.7), ce = decayEnv(c.length, 0.0022);
  for (let i = 0; i < c.length; i++) x[i] += c[i] * ce[i] * 0.35 * click;
  for (let i = 0; i < secs(0.006); i++) x[i] += Math.sin(TAU * 1700 * i / SR) * Math.exp(-i / (0.0012 * SR)) * 0.25 * click;
  hp(x, 28, 0.7);
  return fadeEdges(norm(x, 1), 0, 0.02);
}
export function snare(rnd, { tone = 190, snappy = 0.75, decay = 0.16 } = {}) {
  const n = secs(decay * 3 + 0.05), body = new Float32Array(n), st = { p: 0 };
  for (let i = 0; i < n; i++) { const t = i / SR, f = tone * (1 + 0.45 * Math.exp(-t / 0.012)); body[i] = oscStep(st, f / SR, 'tri') * Math.exp(-t / 0.055); }
  const nz = whiteNoise(n, rnd); hp(nz, 1400, 0.7); peak(nz, 5200, 1, 4); lp(nz, 11000);
  const ne = decayEnv(n, decay, 0.0008);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = body[i] * 0.9 + nz[i] * ne[i] * snappy * 1.1;
  saturate(x, 1.4);
  return fadeEdges(norm(x, 1), 0, 0.02);
}
export function clap(rnd, { decay = 0.13, tone = 1150 } = {}) {
  const n = secs(decay * 4 + 0.08), out = stereo(n);
  for (const [ch, s] of [[out.L, 11], [out.R, 23]]) {
    const r2 = rngShift(rnd, s), nz = whiteNoise(n, r2); bp(nz, tone, 1.1); hp(nz, 650, 0.7); peak(nz, 2600, 1.2, 3);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let e = 0;
      for (const [o, g] of [[0, 0.8], [0.0095, 0.75], [0.019, 0.7]]) if (t >= o) e = Math.max(e, g * Math.exp(-(t - o) / 0.0045));
      if (t >= 0.027) e = Math.max(e, Math.exp(-(t - 0.027) / decay));
      ch[i] = nz[i] * e;
    }
  }
  return fadeEdges(normS(out, 1), 0, 0.03);
}
function rngShift(rnd, salt) { let s = Math.floor(rnd() * 1e9) ^ salt; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const METAL = [205.3, 304.4, 369.6, 522.7, 540, 800];
export function hat(rnd, { open = false, decay, tone = 1 } = {}) {
  const d = decay ?? (open ? 0.24 : 0.035), n = secs(d * 4 + 0.02), x = new Float32Array(n);
  const sts = METAL.map(() => ({ p: rnd() }));
  for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < 6; k++) s += oscStep(sts[k], METAL[k] * 1.8 * tone / SR, 'square'); x[i] = s / 6; }
  const nz = whiteNoise(n, rnd);
  for (let i = 0; i < n; i++) x[i] = x[i] * 0.55 + nz[i] * 0.45;
  hp(x, 7200, 0.9); hp(x, 7200, 0.6); peak(x, 10500, 1.2, 3); lp(x, 16000);
  const e = decayEnv(n, d, 0.0005);
  for (let i = 0; i < n; i++) x[i] *= e[i];
  return fadeEdges(norm(x, 1), 0, 0.01);
}
export function shaker(rnd, { decay = 0.05 } = {}) {
  const n = secs(decay * 4 + 0.03), x = whiteNoise(n, rnd); bp(x, 7000, 0.9); hp(x, 4000);
  for (let i = 0; i < n; i++) { const t = i / SR; x[i] *= (t < 0.012 ? t / 0.012 : Math.exp(-(t - 0.012) / decay)); }
  return fadeEdges(norm(x, 1), 0, 0.01);
}
export function rim(rnd, { tone = 1650 } = {}) {
  const n = secs(0.08), x = new Float32Array(n), a = { p: 0 }, b = { p: 0 };
  for (let i = 0; i < n; i++) { const t = i / SR; x[i] = (oscStep(a, tone / SR, 'tri') + 0.6 * oscStep(b, tone * 0.47 / SR, 'sine')) * Math.exp(-t / 0.012); }
  const nz = hp(whiteNoise(n, rnd), 3000); for (let i = 0; i < n; i++) x[i] += nz[i] * Math.exp(-i / (0.004 * SR)) * 0.4;
  return fadeEdges(norm(x, 1), 0, 0.01);
}
export function cowbell(rnd, { decay = 0.22 } = {}) {
  const n = secs(decay * 3), x = new Float32Array(n), a = { p: 0 }, b = { p: 0 };
  for (let i = 0; i < n; i++) { const t = i / SR; x[i] = (oscStep(a, 562 / SR, 'square') + oscStep(b, 845 / SR, 'square')) * (0.6 * Math.exp(-t / 0.03) + 0.4 * Math.exp(-t / decay)); }
  bp(x, 800, 1.6); saturate(x, 1.5);
  return fadeEdges(norm(x, 1), 0, 0.02);
}
export function tom(rnd, { tone = 82, decay = 0.6, big = true } = {}) {
  const n = secs(decay * 2.5), x = new Float32Array(n), st = { p: 0 };
  for (let i = 0; i < n; i++) { const t = i / SR, f = tone * (1 + 0.7 * Math.exp(-t / 0.04)); x[i] = oscStep(st, f / SR, 'sine') * Math.exp(-t / decay); }
  const nz = lp(whiteNoise(n, rnd), big ? 900 : 1800); const ne = decayEnv(n, 0.05);
  for (let i = 0; i < n; i++) x[i] += nz[i] * ne[i] * 0.7;
  saturate(x, 1.8);
  return fadeEdges(norm(x, 1), 0, 0.03);
}
export function crash(rnd, { decay = 1.6 } = {}) {
  const n = secs(decay * 2.2), out = stereo(n);
  for (const ch of [out.L, out.R]) {
    const sts = METAL.map(() => ({ p: rnd() })), nz = whiteNoise(n, rnd);
    for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < 6; k++) s += oscStep(sts[k], METAL[k] * 1.33 / SR, 'square'); ch[i] = s / 6 * 0.4 + nz[i] * 0.6; }
    hp(ch, 4200, 0.7); peak(ch, 8000, 0.8, 3); lp(ch, 15000);
    const e = decayEnv(n, decay * 0.45, 0.001); for (let i = 0; i < n; i++) ch[i] *= e[i];
  }
  return fadeEdges(normS(out, 1), 0, 0.2);
}

// ------------------------------------------------------------------ bass
/** 808: clean sine sub in parallel with a saturated copy for presence on small speakers; optional glide. */
export function sub808(rnd, { freq, dur, glideFrom, drive = 2.4, decay = 1.6 } = {}) {
  const n = secs(dur + 0.02), x = new Float32Array(n), st = { p: 0.25 };
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let f = freq * (1 + 0.6 * Math.exp(-t / 0.015));
    if (glideFrom && t < 0.09) f = glideFrom * (f / glideFrom) ** (t / 0.09);
    x[i] = oscStep(st, f / SR, 'sine') * (t < 0.002 ? t / 0.002 : Math.exp(-t / decay));
  }
  const dirty = Float32Array.from(x); saturate(dirty, drive); lp(dirty, 1600); hp(dirty, 120);
  for (let i = 0; i < n; i++) x[i] = x[i] * 0.8 + dirty[i] * 0.45;
  return fadeEdges(norm(x, 1), 0.001, 0.015);
}
export function bass(rnd, { freq, dur, style = 'pluck', vel = 1 } = {}) {
  const presets = {
    pluck: { waves: [{ type: 'saw', gain: 0.7 }, { type: 'sine', gain: 1, unison: false }], unison: { voices: 2, detune: 8, spread: 0 }, filter: { cutoff: 220, q: 1.1, envAmt: 3.2, env: { a: 0.001, d: 0.14, s: 0.15, r: 0.08 }, poles: 4 }, amp: { a: 0.002, d: 0.25, s: 0.75, r: 0.05 }, drive: 1.3 },
    sustain: { waves: [{ type: 'saw', gain: 0.6 }, { type: 'sine', gain: 1, unison: false }], unison: { voices: 3, detune: 10, spread: 0 }, filter: { cutoff: 380, q: 0.9, envAmt: 1.5, env: { a: 0.005, d: 0.3, s: 0.3, r: 0.1 }, poles: 4 }, amp: { a: 0.004, d: 0.3, s: 0.9, r: 0.08 }, drive: 1.2 },
    house: { waves: [{ type: 'pulse', gain: 0.6, width: 0.35 }, { type: 'sine', gain: 1, unison: false }], filter: { cutoff: 300, q: 1.6, envAmt: 2.6, env: { a: 0.001, d: 0.09, s: 0.05, r: 0.05 }, poles: 2 }, amp: { a: 0.002, d: 0.16, s: 0.35, r: 0.04 }, drive: 1.6 },
    synthwave: { waves: [{ type: 'saw', gain: 0.8 }, { type: 'sine', gain: 0.8, unison: false }], unison: { voices: 2, detune: 6, spread: 0 }, filter: { cutoff: 260, q: 1.3, envAmt: 2.4, env: { a: 0.001, d: 0.12, s: 0.2, r: 0.06 }, poles: 4 }, amp: { a: 0.002, d: 0.2, s: 0.7, r: 0.05 }, drive: 1.2 },
    lofi: { waves: [{ type: 'sine', gain: 1 }, { type: 'tri', gain: 0.4 }], filter: { cutoff: 900, q: 0.7 }, amp: { a: 0.008, d: 0.4, s: 0.6, r: 0.12 }, drive: 1.5 },
    cinematic: { waves: [{ type: 'saw', gain: 0.6 }, { type: 'sine', gain: 1, unison: false }], unison: { voices: 3, detune: 12, spread: 0.2 }, filter: { cutoff: 260, q: 0.8, envAmt: 1.2, env: { a: 0.08, d: 0.8, s: 0.4, r: 0.4 }, poles: 4 }, amp: { a: 0.02, d: 0.6, s: 0.85, r: 0.35 }, drive: 1.4 },
  };
  const p = presets[style] ?? presets.pluck;
  const b = synth({ ...p, freq, dur, filter: { ...p.filter, cutoff: p.filter.cutoff * (0.7 + 0.5 * vel) } }, rnd);
  // bass stays mono below ~150 Hz
  for (let i = 0; i < b.L.length; i++) { const m = (b.L[i] + b.R[i]) * 0.5; b.L[i] = m; b.R[i] = m; }
  return b;
}

// ------------------------------------------------------------------ keys, pads, leads
export function supersaw(rnd, { freq, dur, bright = 1, attack = 0.004, release = 0.18, sustain = 0.6, decay = 0.35, cutoff = 3200, envAmt = 1.6, voices = 7, detune = 22 } = {}) {
  return synth({ freq, dur, waves: [{ type: 'saw', gain: 1 }, { type: 'saw', gain: 0.35, octave: 1, unison: false }],
    unison: { voices, detune, spread: 0.9, blend: 0.75 }, filter: { cutoff: cutoff * bright, q: 0.75, envAmt, env: { a: 0.002, d: decay, s: 0.25, r: release } },
    amp: { a: attack, d: decay, s: sustain, r: release } }, rnd);
}
export function pluck(rnd, { freq, dur, bright = 1, decay = 0.28 } = {}) {
  return synth({ freq, dur, waves: [{ type: 'saw', gain: 0.8 }, { type: 'square', gain: 0.35, detune: 7 }], unison: { voices: 3, detune: 9, spread: 0.6 },
    filter: { cutoff: freq * 1.5 * bright, q: 0.9, envAmt: 4.2, env: { a: 0.001, d: decay * 0.55, s: 0.05, r: 0.1 } },
    amp: { a: 0.001, d: decay, s: 0.12, r: 0.12 } }, rnd);
}
export function pad(rnd, { freq, dur, warm = 1, attack = 0.5, release = 1.2 } = {}) {
  return synth({ freq, dur, waves: [{ type: 'saw', gain: 0.8 }, { type: 'tri', gain: 0.6, octave: 1 }], unison: { voices: 5, detune: 16, spread: 1, blend: 0.8 },
    filter: { cutoff: 1500 * warm, q: 0.7, lfo: { rate: 0.13, depth: 0.25, phase: rnd() * 6 } }, amp: { a: attack, d: 1, s: 0.85, r: release } }, rnd);
}
export function strings(rnd, { freq, dur, attack = 0.35, release = 0.8 } = {}) {
  return synth({ freq, dur, waves: [{ type: 'saw', gain: 1 }], unison: { voices: 4, detune: 14, spread: 0.8, blend: 0.85 },
    filter: { cutoff: 2600, q: 0.6, envAmt: 0.6, env: { a: attack, d: 1, s: 0.7, r: release } }, vibrato: { rate: 5.2, cents: 7, delay: 0.3 },
    amp: { a: attack, d: 1, s: 0.9, r: release } }, rnd);
}
export function brass(rnd, { freq, dur } = {}) {
  return synth({ freq, dur, waves: [{ type: 'saw', gain: 1 }, { type: 'square', gain: 0.5, octave: -1, unison: false }], unison: { voices: 3, detune: 9, spread: 0.5 },
    filter: { cutoff: 380, q: 0.9, envAmt: 2.6, env: { a: 0.22, d: 0.6, s: 0.55, r: 0.4 } }, amp: { a: 0.06, d: 0.5, s: 0.85, r: 0.5 }, drive: 1.8 }, rnd);
}
export function lead(rnd, { freq, dur, glideFrom, bright = 1 } = {}) {
  return synth({ freq, dur, glide: glideFrom ? { from: glideFrom, time: 0.05 } : null, waves: [{ type: 'saw', gain: 0.8 }, { type: 'square', gain: 0.4, octave: -1 }],
    unison: { voices: 3, detune: 12, spread: 0.5 }, vibrato: { rate: 5.5, cents: 14, delay: 0.18 },
    filter: { cutoff: 2600 * bright, q: 0.9, envAmt: 1.2, env: { a: 0.003, d: 0.25, s: 0.5, r: 0.12 } }, amp: { a: 0.004, d: 0.2, s: 0.8, r: 0.1 } }, rnd);
}
/** Electric piano: two-operator FM (tine + bar) with velocity-dependent brightness and stereo tremolo. */
export function ep(rnd, { freq, dur, vel = 0.8 } = {}) {
  const n = secs(dur + 0.4), out = stereo(n), c = { p: 0 }, m = { p: 0 }, m2 = { p: 0 }, c2 = { p: 0 };
  const env = adsr(n, { a: 0.002, d: 1.6, s: 0.25, r: 0.35, gate: dur, curve: 0 });
  for (let i = 0; i < n; i++) {
    const t = i / SR, idx = (1.2 + 1.6 * vel) * Math.exp(-t / 0.35) + 0.25, tine = 0.7 * vel * Math.exp(-t / 0.03);
    const mod = Math.sin(TAU * m.p) * idx; m.p = (m.p + freq / SR) % 1;
    const mod2 = Math.sin(TAU * m2.p) * tine; m2.p = (m2.p + freq * 14 / SR) % 1;
    const y = Math.sin(TAU * c.p + mod) * 0.85 + Math.sin(TAU * c2.p + mod2) * 0.18; c.p = (c.p + freq / SR) % 1; c2.p = (c2.p + freq * 1.003 / SR) % 1;
    const tr = 0.15 * Math.sin(TAU * 4.2 * t);
    out.L[i] = y * env[i] * (1 + tr); out.R[i] = y * env[i] * (1 - tr);
  }
  for (const ch of [out.L, out.R]) { lp(ch, 5200); saturate(ch, 1.2); }
  return fadeEdges(out, 0.0005, 0.01);
}
/** FM bell / mallet: inharmonic ratio, bright attack, long ring. */
export function bell(rnd, { freq, dur, ratio = 3.5, ring = 1.4, vel = 0.9 } = {}) {
  const n = secs(Math.max(dur, 0.2) + ring * 1.5), out = stereo(n), c = { p: 0 }, m = { p: 0 }, c2 = { p: 0.3 };
  for (let i = 0; i < n; i++) {
    const t = i / SR, idx = (2.4 * vel) * Math.exp(-t / 0.25) + 0.3;
    const mod = Math.sin(TAU * m.p) * idx; m.p = (m.p + freq * ratio / SR) % 1;
    const a = t < 0.001 ? t / 0.001 : Math.exp(-t / ring);
    const y = (Math.sin(TAU * c.p + mod) + 0.3 * Math.sin(TAU * c2.p)) * a; c.p = (c.p + freq / SR) % 1; c2.p = (c2.p + freq * 2.002 / SR) % 1;
    out.L[i] = y; out.R[i] = y;
  }
  for (const ch of [out.L, out.R]) lp(ch, 9000);
  return fadeEdges(out, 0.0005, 0.05);
}
export function piano(rnd, { freq, dur, vel = 0.8 } = {}) {
  // Bright FM "felt piano": several detuned partials with hammer noise; good for emotional / cinematic beds.
  const n = secs(dur + 0.8), out = stereo(n);
  const parts = [[1, 1, 1.8], [2, 0.45, 1.1], [3, 0.22, 0.7], [4, 0.12, 0.45], [5, 0.06, 0.3]];
  for (const [k, g, d] of parts) {
    const st = { p: rnd() }, f = freq * k * (1 + 0.0004 * k * k);
    const dec = d * (440 / Math.max(110, freq)) ** 0.35;
    for (let i = 0; i < n; i++) { const t = i / SR; const y = Math.sin(TAU * st.p) * g * Math.exp(-t / dec) * (t < 0.002 ? t / 0.002 : 1); st.p = (st.p + f / SR) % 1; out.L[i] += y; out.R[i] += y; }
  }
  const ham = lp(whiteNoise(secs(0.02), rnd), 2500);
  for (let i = 0; i < ham.length; i++) { const v = ham[i] * Math.exp(-i / (0.004 * SR)) * 0.25 * vel; out.L[i] += v; out.R[i] += v; }
  const rel = adsr(n, { a: 0.001, d: 10, s: 1, r: 0.3, gate: dur + 0.05 });
  for (let i = 0; i < n; i++) { out.L[i] *= rel[i] * vel; out.R[i] *= rel[i] * vel; }
  for (const ch of [out.L, out.R]) lp(ch, 2200 + 4000 * vel);
  return fadeEdges(out, 0.0005, 0.02);
}

// ------------------------------------------------------------------ transition effects
export function riser(rnd, { dur = 1.875, from = 350, to = 9000 } = {}) {
  const n = secs(dur), out = stereo(n);
  for (const [ch, salt] of [[out.L, 3], [out.R, 7]]) {
    const nz = whiteNoise(n, rngShift(rnd, salt));
    svfProcess(nz, { type: 'bp', q: 2.2, cutoff: t => from * (to / from) ** Math.min(1, t / dur) });
    for (let i = 0; i < n; i++) { const x = i / n; ch[i] = nz[i] * x ** 2.2; }
  }
  // pitched sweep underneath
  const st = { p: 0 }, st2 = { p: 0.5 };
  for (let i = 0; i < n; i++) { const x = i / n, f = 110 * 2 ** (x * 2.2); const y = (oscStep(st, f / SR, 'saw') + oscStep(st2, f * 1.007 / SR, 'saw')) * 0.2 * x ** 2.5; out.L[i] += y; out.R[i] += y; }
  for (const ch of [out.L, out.R]) { hp(ch, 180); lp(ch, 12000); }
  return fadeEdges(normS(out, 1), 0.05, 0.004);
}
export function downlifter(rnd, { dur = 1.6 } = {}) {
  const n = secs(dur), out = stereo(n);
  for (const [ch, salt] of [[out.L, 5], [out.R, 9]]) {
    const nz = whiteNoise(n, rngShift(rnd, salt));
    svfProcess(nz, { type: 'bp', q: 1.6, cutoff: t => 7000 * (250 / 7000) ** Math.min(1, t / dur) });
    for (let i = 0; i < n; i++) ch[i] = nz[i] * (1 - i / n) ** 1.6;
  }
  return fadeEdges(normS(out, 1), 0.002, 0.05);
}
export function revCymbal(rnd, { dur = 1.2 } = {}) {
  const c = crash(rnd, { decay: dur });
  const n = secs(dur), out = stereo(n);
  for (let i = 0; i < n; i++) { const j = n - 1 - i; out.L[i] = c.L[j] ?? 0; out.R[i] = c.R[j] ?? 0; }
  return fadeEdges(out, 0.02, 0.003);
}
export function impact(rnd, { decay = 2.2, tone = 42 } = {}) {
  const n = secs(decay * 1.6), out = stereo(n), st = { p: 0.25 };
  for (let i = 0; i < n; i++) { const t = i / SR, f = tone * (1 + 1.4 * Math.exp(-t / 0.05)); const y = Math.sin(TAU * st.p) * Math.exp(-t / (decay * 0.45)); st.p = (st.p + f / SR) % 1; out.L[i] = y; out.R[i] = y; }
  for (const [ch, salt] of [[out.L, 2], [out.R, 4]]) { const nz = lp(whiteNoise(n, rngShift(rnd, salt)), 1800); for (let i = 0; i < n; i++) ch[i] += nz[i] * Math.exp(-i / (0.08 * SR)) * 0.6; saturate(ch, 1.6); }
  return fadeEdges(normS(out, 1), 0, 0.2);
}
export function subDrop(rnd, { dur = 1.4 } = {}) {
  const n = secs(dur), x = new Float32Array(n), st = { p: 0.25 };
  for (let i = 0; i < n; i++) { const t = i / SR, f = 70 * (32 / 70) ** (t / dur); x[i] = Math.sin(TAU * st.p) * (t < 0.003 ? t / 0.003 : 1) * (1 - t / dur) ** 0.5; st.p = (st.p + f / SR) % 1; }
  saturate(x, 1.3);
  return fadeEdges(norm(x, 1), 0, 0.05);
}
export function vinyl(rnd, { dur } = {}) {
  const n = secs(dur), out = stereo(n), hiss = pinkNoise(n, rnd);
  lp(hiss, 5500); hp(hiss, 300);
  for (let i = 0; i < n; i++) { out.L[i] = hiss[i] * 0.05; out.R[i] = hiss[i] * 0.05; }
  const clicks = Math.round(dur * 7);
  for (let k = 0; k < clicks; k++) {
    const at = Math.floor(rnd() * (n - 200)), a = (rnd() * 0.5 + 0.2) * (rnd() < 0.15 ? 2 : 1), ch = rnd() < 0.5 ? out.L : out.R;
    for (let i = 0; i < 40; i++) ch[at + i] += (rnd() * 2 - 1) * a * Math.exp(-i / 6);
  }
  return out;
}
