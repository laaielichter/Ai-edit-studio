// Music engine composer: harmony, melody, drums and arrangement for a given length and set of hit points.
// Output is a score (events per track in seconds) that the mixer renders.
import { rng, clamp } from './dsp.mjs';

// ------------------------------------------------------------------ theory
const MAJOR = [0, 2, 4, 5, 7, 9, 11], MINOR = [0, 2, 3, 5, 7, 8, 10], DORIAN = [0, 2, 3, 5, 7, 9, 10];
const NOTE = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/** Progressions as scale degrees (0-based) per mood; minor ones may use a major V (harmonic minor). */
export const MOODS = Object.freeze({
  uplifting: { mode: 'major', progs: [[0, 4, 5, 3], [3, 0, 4, 5], [0, 5, 3, 4], [5, 3, 0, 4]] },
  emotional: { mode: 'minor', progs: [[5, 6, 0, 0], [0, 5, 2, 6], [5, 2, 6, 0], [0, 3, 5, 6]] },
  epic: { mode: 'minor', progs: [[0, 5, 2, 6], [0, 6, 5, 6], [5, 6, 0, 0], [0, 5, 3, 4]] },
  dark: { mode: 'minor', progs: [[0, 3, 5, 4], [0, 0, 5, 4], [0, 5, 3, 4], [0, 1, 0, 4]], majorV: true },
  chill: { mode: 'major', progs: [[1, 4, 0, 5], [0, 5, 1, 4], [3, 2, 1, 0], [0, 2, 3, 4]], sevenths: true },
  dreamy: { mode: 'dorian', progs: [[0, 3, 0, 3], [0, 6, 3, 0], [3, 4, 0, 0]], sevenths: true },
});
function scaleOf(mode) { return mode === 'major' ? MAJOR : mode === 'dorian' ? DORIAN : MINOR; }
/** Chord tones (pitch classes relative to C) for a scale degree. */
export function chordOf(root, mode, degree, { sevenths = false, majorV = false, add9 = false } = {}) {
  const sc = scaleOf(mode), pc = k => (root + sc[((degree + k) % 7 + 7) % 7] + 12 * Math.floor((degree + k) / 7)) ;
  const tones = [pc(0), pc(2), pc(4)];
  if (majorV && mode === 'minor' && degree === 4) tones[1] += 1; // raised leading tone
  if (sevenths) tones.push(pc(6));
  if (add9) tones.push(pc(8));
  return { degree, root: ((tones[0] % 12) + 12) % 12, tones: tones.map(t => ((t % 12) + 12) % 12), bass: tones[0] };
}
/** Voice a chord near the previous voicing (smallest total movement) inside [lo, hi]. */
export function voice(chord, prev, { lo = 52, hi = 76, size = 4, center = 62 } = {}) {
  // distinct chord tones in close position; triads get the lowest voice doubled an octave up (4-voice close voicing)
  const pcs = [...new Set(chord.tones)].slice(0, size);
  const candidates = [];
  for (let inv = 0; inv < pcs.length; inv++) {
    const order = [...pcs.slice(inv), ...pcs.slice(0, inv)];
    for (let base = lo - 12; base <= hi; base++) {
      if (((base % 12) + 12) % 12 !== order[0]) continue;
      const v = [base];
      for (let k = 1; k < order.length; k++) { let m = v[k - 1] + 1; while (((m % 12) + 12) % 12 !== order[k]) m++; v.push(m); }
      while (v.length < size) v.push(v[v.length - pcs.length] + 12);
      if (v[0] >= lo && v.at(-1) <= hi) candidates.push(v);
    }
  }
  if (!candidates.length) return pcs.map((p, k) => 60 + p + (k && pcs[k] <= pcs[k - 1] ? 12 : 0));
  const cost = v => prev ? v.reduce((s, m, k) => s + Math.abs(m - (prev[k] ?? prev.at(-1))), 0) + Math.abs(v[0] - center + 6) * 0.15 : Math.abs(v.reduce((a, b) => a + b, 0) / v.length - center);
  return candidates.sort((a, b) => cost(a) - cost(b))[0];
}
const nearest = (pc, target) => { let m = target - 6; while (((m % 12) + 12) % 12 !== pc) m++; return m; };

// ------------------------------------------------------------------ styles
/**
 * Each style: tempo range, default mood, instruments per role and a mix recipe (relative loudness targets, LUFS).
 */
export const STYLES = Object.freeze({
  pop: { name: 'Pop drop', tonal: [-9, 0, -1.5, -3.5, -5, -6.5, -8, -10, -12.5, -18.5], bpm: [118, 132], defaultBpm: 128, mood: 'emotional', swing: 0, reverb: { decay: 2.4, size: 1.1 }, delay: 0.75, sidechain: 0.55, master: -10,
    mix: { kick: -9, clap: -13, hats: -20, perc: -22, bass: -11.5, chords: -13, pad: -19, lead: -15.5, fx: -17 }, desc: 'Big future-pop drop: supersaw chords, pluck hook, four-on-the-floor, sidechain pump.' },
  trap: { name: 'Trap / hip-hop', tonal: [-6, 0, -2.5, -5, -6.5, -8, -9.5, -11, -13, -19], bpm: [134, 150], defaultBpm: 140, mood: 'dark', swing: 0, reverb: { decay: 1.8, size: 0.9 }, delay: 0.75, sidechain: 0, master: -10,
    mix: { kick: -10, clap: -13, hats: -18, perc: -21, bass: -10, chords: -17, pad: -19, lead: -13, fx: -18 }, desc: 'Half-time trap: gliding 808, hi-hat rolls, bell melody, dark pads.' },
  house: { name: 'House', tonal: [-9, 0, -1.5, -3.5, -5, -6.5, -8, -10, -12.5, -18.5], bpm: [120, 126], defaultBpm: 124, mood: 'uplifting', swing: 0.54, reverb: { decay: 1.6, size: 0.8 }, delay: 0.375, sidechain: 0.45, master: -10,
    mix: { kick: -9, clap: -14, hats: -18, perc: -20, bass: -11.5, chords: -14, pad: -20, lead: -15, fx: -18 }, desc: 'Club house: offbeat bass, chord stabs, open hats, shaker groove.' },
  lofi: { name: 'Lo-fi chill', tonal: [-12, -1.5, 0, -2, -4, -6, -9, -13, -19, -30], bpm: [72, 90], defaultBpm: 82, mood: 'chill', swing: 0.58, reverb: { decay: 1.4, size: 0.7 }, delay: 0.75, sidechain: 0.15, master: -13,
    mix: { kick: -12, clap: -15, hats: -21, perc: -24, bass: -13, chords: -13, pad: -21, lead: -16, fx: -24 }, desc: 'Lo-fi hip-hop: swung boom-bap, jazzy electric-piano sevenths, vinyl texture.' },
  synthwave: { name: 'Synthwave', tonal: [-9, 0, -1.5, -3.5, -5, -6.5, -8, -10, -12.5, -18.5], bpm: [96, 112], defaultBpm: 104, mood: 'epic', swing: 0, reverb: { decay: 2.8, size: 1.2 }, delay: 0.5625, sidechain: 0.3, master: -11,
    mix: { kick: -10, clap: -12, hats: -21, perc: -23, bass: -12, chords: -15, pad: -16, lead: -13, fx: -18 }, desc: 'Retro 80s: pulsing octave bass, gated snare, arpeggios, lush pads.' },
  cinematic: { name: 'Cinematic trailer', tonal: [-6, 0, -1, -2.5, -4, -6, -8.5, -11, -14, -20], bpm: [84, 100], defaultBpm: 90, mood: 'epic', swing: 0, reverb: { decay: 3.6, size: 1.4 }, delay: 0.75, sidechain: 0, master: -12,
    mix: { kick: -10, clap: -15, hats: -22, perc: -14, bass: -12, chords: -13, pad: -15, lead: -14, fx: -13 }, desc: 'Trailer epic: taiko ostinato, string spiccato, brass braams, impacts and risers.' },
});
export const styleList = () => Object.entries(STYLES).map(([id, s]) => ({ id, name: s.name, bpm: s.defaultBpm, bpmRange: s.bpm, mood: s.mood, description: s.desc }));

// ------------------------------------------------------------------ timing: fit bars to the edit
/**
 * Choose bpm + phase so structural anchors (drops, the final hit) fall on bar lines.
 * Returns { bpm, bar, phase, anchors:[{time, bar}], error }.
 */
export function fitGrid({ anchors = [], bpmRange, defaultBpm, bpm: wanted }) {
  const pts = [...new Set(anchors.map(a => Math.round(a * 1000) / 1000))].sort((a, b) => a - b);
  const pref = wanted ?? defaultBpm, [lo, hi] = wanted ? [wanted * 0.97, wanted * 1.03] : bpmRange;
  if (pts.length === 0) return { bpm: pref, bar: 240 / pref, phase: 0, anchors: [], error: 0 };
  if (pts.length === 1) { const bar = 240 / pref; return { bpm: pref, bar, phase: ((pts[0] % bar) + bar) % bar, anchors: [{ time: pts[0], bar: Math.round((pts[0] - ((pts[0] % bar) + bar) % bar) / bar) }], error: 0 }; }
  let best = null;
  const span = pts.at(-1) - pts[0];
  for (let m = 1; m <= 64; m++) {
    const bar = span / m, bpm = 240 / bar;
    // allow half/double feel inside the range
    if (bpm < lo - 0.01 || bpm > hi + 0.01) continue;
    const phase = ((pts[0] % bar) + bar) % bar;
    let err = 0; const fitted = pts.map(t => { const k = Math.round((t - phase) / bar); err = Math.max(err, Math.abs(phase + k * bar - t)); return { time: t, bar: k }; });
    const score = err * 40 + Math.abs(bpm - pref) / pref;
    if (!best || score < best.score) best = { bpm, bar, phase, anchors: fitted, error: err, score };
  }
  if (!best) { // nothing fits the range: keep the preferred tempo and the LAST anchor (the ending) exact
    const bar = 240 / pref, phase = ((pts.at(-1) % bar) + bar) % bar;
    return { bpm: pref, bar, phase, anchors: pts.map(t => ({ time: t, bar: Math.round((t - phase) / bar) })), error: null };
  }
  delete best.score;
  return best;
}

// ------------------------------------------------------------------ drums
function drumBar(style, section, r, at, barIdx, nextIsDrop) {
  const ev = { kick: [], clap: [], hats: [], perc: [] };
  const full = section === 'drop' || section === 'drop2', build = section === 'build', light = section === 'intro' || section === 'verse', brk = section === 'break';
  const k = (s, v = 1) => ev.kick.push({ step: s, vel: v }), c = (s, v = 1, kind = 'clap') => ev.clap.push({ step: s, vel: v, kind }), h = (s, v = 1, kind = 'hat') => ev.hats.push({ step: s, vel: v, kind }), p = (s, v = 1, kind = 'shaker') => ev.perc.push({ step: s, vel: v, kind });
  if (style === 'pop' || style === 'house') {
    if (full || (light && style === 'house')) for (const s of [0, 4, 8, 12]) k(s);
    if (light && style === 'pop') { k(0); if (r.chance(0.5)) k(10, 0.8); }
    if (full || light) { c(4); c(12); }
    if (full || light) for (let s = 2; s < 16; s += 4) h(s, style === 'house' ? 0.9 : 0.75, style === 'house' ? 'open' : 'hat');
    if (full) for (let s = 0; s < 16; s++) if (s % 4 !== 2) h(s, s % 2 ? 0.42 : 0.6);
    if (full || (style === 'house' && light)) for (let s = 0; s < 16; s++) p(s, s % 2 ? 0.5 : 0.8, 'shaker');
    if (style === 'house' && full) { p(3, 0.6, 'rim'); p(11, 0.5, 'rim'); }
    if (brk) { for (let s = 0; s < 16; s += 2) h(s, 0.4); }
  } else if (style === 'trap') {
    if (full || light) {
      const pats = [[0, 10], [0, 7, 10], [0, 3, 10, 14], [0, 11]];
      for (const s of pats[(((barIdx + (r() < 0.3 ? 1 : 0)) % pats.length) + pats.length) % pats.length]) k(s, s ? 0.9 : 1);
      c(8, 1, 'clap'); if (full) c(8, 0.7, 'snare');
      // hats: 8ths/16ths with rolls
      for (let s = 0; s < 16; s += full ? 1 : 2) h(s, s % 4 === 0 ? 0.85 : s % 2 ? 0.45 : 0.65);
      if (full) for (let roll = 0; roll < 1 + (r() < 0.5); roll++) {
        const at16 = r.pick([6, 10, 14, 13]), n = r.pick([3, 4, 6]);
        for (let j = 0; j < n; j++) h(at16 + j / (n / 2) * 1, 0.4 + 0.4 * j / n, 'hat');
      }
      if (full && barIdx % 2) h(14, 0.7, 'open');
    }
    if (brk) for (let s = 0; s < 16; s += 4) h(s, 0.4);
  } else if (style === 'lofi') {
    if (!brk) { k(0); k(7, 0.75); k(10, 0.9); if (r.chance(0.4)) k(15, 0.5); c(4, 1, 'snare'); c(12, 1, 'snare'); c(r.pick([11, 14]), 0.25, 'snare'); }
    for (let s = 0; s < 16; s += 2) h(s, (s % 4 ? 0.45 : 0.7) * (0.85 + 0.3 * r()));
    if (!brk) { p(6, 0.35, 'rim'); if (r.chance(0.5)) p(13, 0.25, 'rim'); }
  } else if (style === 'synthwave') {
    if (full) for (const s of [0, 4, 8, 12]) k(s); else if (light) { k(0); k(8); }
    if (full || light) { c(4, 1, 'snare'); c(12, 1, 'snare'); }
    if (full) for (let s = 0; s < 16; s++) h(s, s % 2 ? 0.45 : 0.7); else if (light) for (let s = 0; s < 16; s += 2) h(s, 0.55);
    if (full) p(2, 0.4, 'shaker');
  } else if (style === 'cinematic') {
    if (full) {
      for (const s of [0, 3, 6, 8, 10, 11, 14]) p(s, s === 0 || s === 8 ? 1 : 0.7, 'taiko');
      k(0); k(8, 0.8); c(4, 0.8, 'snare'); c(12, 0.9, 'snare');
      for (let s = 0; s < 16; s += 2) h(s, 0.35, 'shaker');
    } else if (light) { p(0, 0.8, 'taiko'); p(8, 0.6, 'taiko'); }
    else if (brk) p(0, 0.5, 'taiko');
  }
  if (build) {
    // snare roll that doubles in density towards the drop (8ths, 16ths, then 32nds) with rising velocity
    const kind = style === 'cinematic' ? 'taiko' : 'snare';
    const hit = (s, v) => (kind === 'taiko' ? p : c)(s, v, kind);
    for (let s = 0; s < 14; s++) {
      const v = 0.3 + 0.65 * (s / 14);
      if (s < 8) { if (s % 2 === 0) hit(s, v); }
      else if (s < 12) hit(s, v);
      else { hit(s, v); hit(s + 0.5, v); }
    }
    // the last eighth before the drop stays empty: the gap makes the drop hit harder
    if (style !== 'cinematic' && style !== 'lofi') for (const s of [0, 4, 8, 12]) k(s, 0.55 + 0.1 * s / 4);
  }
  if (nextIsDrop && (full || light) && style !== 'lofi') {
    // a short fill in the last beat into the next section
    ev.clap = ev.clap.filter(e => e.step < 12);
    for (const s of [12, 13, 14, 14.5, 15, 15.5]) c(s, 0.5 + (s - 12) * 0.12, style === 'cinematic' ? 'snare' : 'snare');
  }
  return { ev };
}

// ------------------------------------------------------------------ melody
const RHYTHMS = {
  pop: [[0, 3, 6, 10, 12], [0, 2, 3, 6, 8, 10, 12], [0, 3, 6, 8, 11, 14], [2, 4, 7, 10, 12], [0, 4, 6, 8, 12, 14]],
  trap: [[0, 3, 6, 8, 12, 14], [0, 2, 3, 6, 10, 12], [0, 6, 8, 11, 14], [0, 3, 6, 10, 12]],
  house: [[0, 3, 6, 10, 12], [2, 5, 8, 11, 14], [0, 3, 7, 10, 14]],
  lofi: [[0, 3, 6, 10], [2, 6, 9, 12], [0, 4, 7, 10, 14]],
  synthwave: [[0, 4, 6, 8, 12], [0, 2, 4, 8, 10, 12], [0, 6, 8, 12, 14]],
  cinematic: [[0, 6, 8, 12], [0, 8, 12], [0, 4, 8, 10, 12]],
};
const MOTIONS = [[0, 2, -1, -1, 2, -1, -1], [0, 1, 1, 1, -2, -1, 1], [0, -1, -1, 2, 1, -1, -2], [0, 2, 2, -1, -1, -2, 1], [0, -2, 1, 1, 1, -1, 2], [0, 1, -1, 2, -1, -2, 1], [0, 0, 2, -1, 2, -1, -1]];
/**
 * Hook writer: a call (bar A) and response (bar B) in scale steps, repeated over the progression so the ear
 * recognises it while the harmony moves. Strong beats land on chord tones; phrase ends resolve to root/third.
 */
function makeHook({ style, r, root, mode, lo, hi, majorV }) {
  const sc = scaleOf(mode), rh = RHYTHMS[style] ?? RHYTHMS.pop;
  const rA = r.pick(rh), rB0 = r.pick(rh);
  const rB = [...rA.filter(s => s < 8), ...rB0.filter(s => s >= 8 && s <= 12)];
  if (rB.at(-1) !== 12) rB.push(12);
  const mA = r.pick(MOTIONS), mB = r.pick(MOTIONS);
  const center = Math.round((lo + hi) / 2);
  const midiOf = (deg, chord) => {
    const d = ((deg % 7) + 7) % 7;
    let m = 12 * (Math.floor(center / 12)) + root + sc[d] + 12 * Math.floor(deg / 7) - 12 * Math.floor((center - root) / 12 - Math.floor(center / 12) + 1);
    if (majorV && chord.degree === 4 && d === 6) m += 1;
    return m;
  };
  // degree helpers: chord tones in degree space are degree, degree+2, degree+4 (+6 for sevenths)
  const isChordDeg = (deg, chord) => [0, 2, 4, ...(chord.tones.length > 3 ? [6] : [])].includes((((deg - chord.degree) % 7) + 7) % 7);
  const snap = (deg, chord) => { for (const d of [0, 1, -1, 2, -2]) if (isChordDeg(deg + d, chord)) return deg + d; return deg; };
  const toRange = (deg, chord) => { let m = midiOf(deg, chord); while (m < lo) { deg += 7; m = midiOf(deg, chord); } while (m > hi) { deg -= 7; m = midiOf(deg, chord); } return deg; };
  let lastDeg = null;
  return (barNo, chord) => {
    const isB = barNo % 2 === 1, steps = isB ? rB : rA, motion = isB ? mB : mA;
    // start each bar on a chord tone near the last note (smooth line), first bar on the 3rd or 5th
    let deg = lastDeg === null ? chord.degree + 7 + r.pick([2, 4]) : lastDeg;
    deg = toRange(snap(deg, chord), chord);
    const out = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i], next = steps[i + 1] ?? 16;
      if (i > 0) {
        const m = motion[i % motion.length];
        // bounce off the range edges instead of jumping an octave
        if (midiOf(deg + m, chord) > hi || midiOf(deg + m, chord) < lo) deg -= m; else deg += m;
      }
      const strong = s === 0 || s === 8 || i === 0;
      if (strong) { deg = snap(deg, chord); if (midiOf(deg, chord) > hi) deg -= 2; if (midiOf(deg, chord) < lo) deg += 2; deg = snap(deg, chord); }
      out.push({ step: s, len: Math.max(1, next - s), midi: midiOf(deg, chord), vel: s % 4 === 0 ? 1 : 0.82, deg });
    }
    if (isB && out.length) { // response ends on root or third, held
      const last = out.at(-1); let d = last.deg;
      for (const k of [0, -1, 1, -2, 2, -3, 3]) { const x = d + k; const rel = (((x - chord.degree) % 7) + 7) % 7; if (rel === 0 || rel === 2) { d = toRange(x, chord); break; } }
      last.deg = d; last.midi = midiOf(d, chord); last.len = 16 - last.step;
    }
    lastDeg = out.length ? out.at(-1).deg : lastDeg;
    return out;
  };
}

// ------------------------------------------------------------------ arrangement
/**
 * Tempo map: bars between consecutive anchors get a whole number of bars each (tempo bends a little per segment),
 * so EVERY anchor (drops, the final hit) lands exactly on a downbeat. The piece starts on a downbeat at 0 s when the
 * first anchor allows it within ±8 %, otherwise with a pickup.
 * Returns { bpm (nominal), bars:[{t, len}], anchorBar: Map(time → bar index), segments:[{from, bpm}] }.
 */
export function tempoMap({ anchors = [], duration, bpmRange, defaultBpm, bpm: wanted }) {
  const pts = [...new Set(anchors.filter(t => t > 0.05).map(t => Math.round(t * 1000) / 1000))].sort((a, b) => a - b);
  const [lo, hi] = wanted ? [wanted * 0.97, wanted * 1.03] : bpmRange;
  const cand = [];
  for (let b = lo; b <= hi + 1e-9; b += 0.25) cand.push(b);
  if (!cand.length) cand.push(wanted ?? defaultBpm);
  const pref = wanted ?? defaultBpm;
  const segsFor = base => {
    const barB = 240 / base, segs = [];
    let cost = Math.abs(base - pref) / pref * 0.5;
    const first = pts[0];
    let start = 0;
    if (first !== undefined) {
      const n0 = Math.round(first / barB);
      if (n0 >= 1 && Math.abs(first / n0 - barB) / barB <= 0.08) { segs.push({ from: 0, to: first, n: n0 }); cost += Math.abs(first / n0 - barB) / barB; }
      else { const n = Math.max(1, Math.ceil(first / barB - 1e-9)); start = first - n * barB; segs.push({ from: start, to: first, n }); cost += 0.05; }
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      const gap = pts[i + 1] - pts[i], n = Math.max(1, Math.round(gap / barB));
      segs.push({ from: pts[i], to: pts[i + 1], n }); cost += Math.abs(gap / n - barB) / barB * 2;
    }
    return { base, segs, cost, start };
  };
  let best = cand.map(segsFor).sort((a, b) => a.cost - b.cost)[0];
  // a structural anchor may bend the tempo by at most 6 %; otherwise it becomes an accent (hit) on its own
  const dropped = [];
  for (let guard = 0; guard < pts.length; guard++) {
    const bad = best.segs.findIndex(sg => Math.abs((sg.to - sg.from) / sg.n - 240 / best.base) / (240 / best.base) > 0.06 && sg.from >= 0);
    if (bad < 0 || pts.length <= 1) break;
    const sg = best.segs[bad], victim = sg.to === pts.at(-1) && bad > 0 ? sg.from : sg.to;
    dropped.push(victim); pts.splice(pts.indexOf(victim), 1);
    best = cand.map(segsFor).sort((a, b) => a.cost - b.cost)[0];
  }
  const bars = [], anchorBar = new Map(), segments = [];
  for (const sg of best.segs) {
    const len = (sg.to - sg.from) / sg.n;
    segments.push({ from: Math.max(0, Math.round(sg.from * 1000) / 1000), bpm: Math.round(240 / len * 100) / 100 });
    for (let j = 0; j < sg.n; j++) bars.push({ t: sg.from + j * len, len });
    anchorBar.set(Math.round(sg.to * 1000) / 1000, bars.length);
  }
  // after the last anchor (or with no anchors at all): keep the last tempo until past the end
  let t = bars.length ? bars.at(-1).t + bars.at(-1).len : 0, len = bars.length ? bars.at(-1).len : 240 / best.base;
  if (!bars.length) segments.push({ from: 0, bpm: Math.round(best.base * 100) / 100 });
  while (t < duration + len) { bars.push({ t, len }); t += len; }
  return { bpm: best.base, bars, anchorBar, segments, dropped };
}

/**
 * compose({ style, mood, duration, drops, ending, seed, key, bpm, intensity })
 * drops: seconds where the music should hit (start of a drop); the final hit lands at duration - tail.
 */
export function compose(spec) {
  const style = STYLES[spec.style] ? spec.style : 'pop', S = STYLES[style];
  const r = rng(Number(spec.seed ?? 1) * 7919 + 13);
  const moodId = MOODS[spec.mood] ? spec.mood : S.mood, mood = MOODS[moodId];
  const duration = clamp(Number(spec.duration) || 30, 4, 600);
  const ending = spec.ending === 'fade' ? 'fade' : 'hit';
  const tail = ending === 'hit' ? clamp(spec.tail ?? Math.min(2.5, duration * 0.12), 1, 6) : 0;
  const endHit = duration - tail;
  const drops = (spec.drops ?? []).map(Number).filter(t => Number.isFinite(t) && t > 0.4 && t < endHit - 0.5).sort((a, b) => a - b);
  const anchors = ending === 'hit' ? [...drops, endHit] : drops;
  const map = tempoMap({ anchors, duration, bpmRange: S.bpm, defaultBpm: S.defaultBpm, bpm: spec.bpm ? Number(spec.bpm) : undefined });
  const bars = map.bars, B = bars.length;
  const keyPc = spec.key && NOTE[String(spec.key).replace(/m$/, '')] !== undefined ? NOTE[String(spec.key).replace(/m$/, '')] : r.pick(mood.mode === 'major' ? [0, 2, 5, 7, 9] : [9, 2, 4, 5, 7, 0]);
  const mode = spec.key ? (/m$/.test(spec.key) ? (mood.mode === 'dorian' ? 'dorian' : 'minor') : 'major') : mood.mode;
  const prog = r.pick(mood.progs);
  const barOf = t => map.anchorBar.get(Math.round(t * 1000) / 1000);
  const dropBars = new Set(drops.map(barOf).filter(k => k !== undefined));
  const endBar = ending === 'hit' ? barOf(endHit) : B;
  const firstDrop = dropBars.size ? Math.min(...dropBars) : null;
  // section per bar
  const sec = [];
  for (let k = 0; k < B; k++) {
    if (k >= endBar) { sec[k] = 'end'; continue; }
    if (firstDrop === null) {
      // no drops: a short intro, then the main groove; long pieces breathe in the middle and build back up
      const total = endBar;
      if (k < Math.min(2, Math.floor(total / 4))) sec[k] = 'intro';
      else if (total >= 16 && k >= Math.floor(total / 2) && k < Math.floor(total / 2) + 4) sec[k] = k === Math.floor(total / 2) + 3 ? 'build' : 'break';
      else sec[k] = 'drop';
      continue;
    }
    if (k < firstDrop) { sec[k] = k === firstDrop - 1 ? 'build' : 'intro'; continue; }
    const nextDrop = [...dropBars].filter(d => d > k).sort((a, b) => a - b)[0];
    if (nextDrop !== undefined && k === nextDrop - 1) { sec[k] = 'build'; continue; }
    const lastDropBefore = Math.max(...[...dropBars].filter(d => d <= k));
    sec[k] = lastDropBefore === firstDrop ? 'drop' : 'drop2';
    const runLen = (nextDrop ?? endBar) - lastDropBefore;
    if (runLen >= 16) { const mid = lastDropBefore + Math.floor(runLen / 2) - 2; if (k >= mid && k < mid + 3) sec[k] = 'break'; if (k === mid + 3) sec[k] = 'build'; }
  }
  const progIndex = k => { const i = k - (firstDrop ?? 0); return ((i % prog.length) + prog.length) % prog.length; };
  const chordAt = k => chordOf(keyPc, mode, prog[sec[k] === 'build' ? prog.length - 1 : progIndex(k)], { sevenths: Boolean(mood.sevenths) || style === 'lofi', majorV: mood.majorV });
  const tracks = { kick: [], clap: [], hats: [], perc: [], bass: [], chords: [], pad: [], lead: [], fx: [] };
  const sideTimes = [];
  const hook = makeHook({ style, r, root: keyPc, mode, majorV: mood.majorV, lo: style === 'trap' ? 72 : style === 'lofi' ? 64 : 69, hi: style === 'trap' ? 88 : style === 'lofi' ? 81 : 86 });
  let prevVoicing = null, prevBass = null;
  const sw = S.swing;
  for (let k = 0; k < Math.min(endBar, B); k++) {
    const { t: t0, len: bar } = bars[k], step = bar / 16, section = sec[k], chord = chordAt(k), next = sec[k + 1];
    const T = s => t0 + s * step + (sw && Number.isInteger(s) && s % 2 === 1 ? (sw - 0.5) * 2 * step : 0);
    const nextIsDrop = (next === 'drop' || next === 'drop2' || next === 'end') && next !== section;
    const isDrop = section === 'drop' || section === 'drop2';
    // --- drums
    const { ev } = drumBar(style, section, r, t0, k, nextIsDrop);
    for (const [name, list] of Object.entries(ev)) for (const e of list) {
      const time = T(e.step) + (style === 'lofi' && name === 'hats' ? (r() - 0.5) * 0.008 : 0);
      tracks[name].push({ t: time, vel: e.vel * (0.92 + 0.08 * r()), kind: e.kind ?? name });
      if (name === 'kick' && isDrop) sideTimes.push(time);
    }
    // --- bass
    const bassMidi = nearest(chord.root, style === 'trap' ? 35 : 40);
    if ((section !== 'break' && section !== 'intro' && section !== 'build') || style === 'lofi' || style === 'cinematic' || (style === 'synthwave' && section !== 'build')) {
      if (style === 'trap') {
        for (const e of ev.kick) {
          const s = e.step, len = Math.max(1, (ev.kick.find(x => x.step > s)?.step ?? 16) - s) * step;
          const m = r.chance(0.2) && s > 0 ? bassMidi + 12 : bassMidi;
          tracks.bass.push({ t: T(s), dur: Math.max(step * 2, len - 0.01), midi: m, kind: '808', glideFrom: prevBass && prevBass !== m && r.chance(0.5) ? prevBass : null }); prevBass = m;
        }
      } else if (style === 'house') {
        for (const s of [2, 6, 10, 14]) tracks.bass.push({ t: T(s), dur: step * 1.6, midi: bassMidi + (s === 10 && r.chance(0.4) ? 12 : 0), kind: 'house', vel: 1 });
        if (isDrop) tracks.bass.push({ t: T(15), dur: step * 0.8, midi: bassMidi + 7, kind: 'house', vel: 0.7 });
      } else if (style === 'synthwave') {
        for (let s = 0; s < 16; s += 2) tracks.bass.push({ t: T(s), dur: step * 1.7, midi: bassMidi + (s % 4 === 2 ? 12 : 0), kind: 'synthwave', vel: s % 4 ? 0.8 : 1 });
      } else if (style === 'lofi') {
        tracks.bass.push({ t: T(0), dur: step * 6, midi: bassMidi, kind: 'lofi' });
        tracks.bass.push({ t: T(7), dur: step * 3, midi: bassMidi + 7, kind: 'lofi', vel: 0.8 });
        tracks.bass.push({ t: T(10), dur: step * 5, midi: bassMidi + (r.chance(0.5) ? 12 : 5), kind: 'lofi', vel: 0.85 });
      } else if (style === 'cinematic') {
        tracks.bass.push({ t: t0, dur: bar - 0.02, midi: bassMidi - 12, kind: 'cinematic' });
      } else if (section !== 'build') { // pop: pulsing 8ths, sidechained
        for (let s = 0; s < 16; s += 2) tracks.bass.push({ t: T(s), dur: step * 1.8, midi: bassMidi + (s === 14 && r.chance(0.35) ? 12 : 0), kind: 'pluck', vel: s % 4 ? 0.85 : 1 });
      }
    }
    // --- harmony
    const voicing = voice(chord, prevVoicing, { lo: style === 'lofi' ? 50 : 53, hi: style === 'lofi' ? 74 : 77, size: 4 });
    prevVoicing = voicing;
    const chordEv = (s, l, kind, vel = 1) => tracks.chords.push({ t: T(s), dur: l * step, notes: voicing, kind, vel, section });
    if (style === 'pop') {
      if (isDrop) { for (const [s, l] of [[0, 3], [3, 3], [6, 2], [8, 3], [11, 3], [14, 2]]) chordEv(s, l - 0.2, 'saw', s % 8 === 0 ? 1 : 0.85); }
      else if (section === 'build') chordEv(0, 13.5, 'sawbuild', 0.7);
      else chordEv(0, 16, 'pianoish', 0.8);
    } else if (style === 'house') {
      if (section !== 'intro') for (const s of [0, 3, 6, 10, 13]) chordEv(s, 1.4, 'stab', s === 0 ? 1 : 0.8); else chordEv(0, 16, 'pad');
    } else if (style === 'trap') chordEv(0, 16, 'darkpad', 0.8);
    else if (style === 'lofi') { chordEv(0, 9, 'ep', 0.85); chordEv(10, 6, 'ep', 0.65); }
    else if (style === 'synthwave') chordEv(0, 16, 'pad');
    else if (style === 'cinematic') { chordEv(0, 16, 'strings'); if (isDrop) for (let s = 0; s < 16; s += 2) tracks.chords.push({ t: T(s), dur: step * 0.9, notes: voicing.slice(0, 3).map(m => m - 12), kind: 'spiccato', vel: s % 4 ? 0.6 : 0.9 }); }
    if (section !== 'break' || style !== 'trap') tracks.pad.push({ t: t0, dur: bar, notes: voicing, kind: style === 'cinematic' ? 'choirpad' : 'pad', vel: isDrop ? 0.8 : 1 });
    if (style === 'cinematic' && isDrop && k % 2 === 0) tracks.chords.push({ t: t0, dur: bar * 1.8, notes: [voicing[0] - 12, voicing[0] - 5], kind: 'brass', vel: 1 });
    // --- melody / hook / arps
    if (isDrop || (style === 'lofi' && section !== 'intro')) {
      const kind = { pop: 'pluck', trap: 'bell', house: 'pluck', lofi: 'bell', synthwave: 'lead', cinematic: 'piano' }[style];
      const notes = hook(k, chord);
      for (const n of notes) tracks.lead.push({ t: T(n.step), dur: n.len * step * (kind === 'lead' ? 0.95 : 0.9), midi: n.midi, vel: n.vel, kind });
      if (section === 'drop2' && style !== 'lofi') for (const n of notes) tracks.lead.push({ t: T(n.step), dur: n.len * step * 0.9, midi: n.midi + 12, vel: n.vel * 0.55, kind: 'bell' });
    }
    if (style === 'synthwave' || (style === 'pop' && section === 'build') || (style === 'cinematic' && section === 'build')) {
      const arp = [...voicing, voicing[1] + 12, voicing[2] + 12];
      for (let s = 0; s < 16; s++) tracks.lead.push({ t: T(s), dur: step * 0.8, midi: arp[s % arp.length] + 12, vel: 0.5 + 0.3 * (s % 4 === 0), kind: 'arp' });
    }
    if (section === 'intro' && style !== 'lofi' && style !== 'trap') for (const n of hook(k, chord)) tracks.lead.push({ t: T(n.step), dur: n.len * step * 0.8, midi: n.midi, vel: n.vel * 0.6, kind: style === 'cinematic' ? 'piano' : 'bellsoft' });
    // --- phrase marks inside long sections: a crash every 4 bars, a small fill before the next phrase
    let secStart = k; while (secStart > 0 && sec[secStart - 1] === section) secStart--;
    const inSec = k - secStart;
    if (isDrop && inSec > 0 && inSec % 4 === 0) tracks.fx.push({ t: t0, kind: 'crash', vel: 0.6 });
    if (isDrop && inSec % 4 === 3 && next === section && style !== 'lofi') {
      for (const s of [14, 14.5, 15, 15.5]) tracks.clap.push({ t: T(s), vel: 0.35 + (s - 14) * 0.15, kind: 'snare' });
      tracks.fx.push({ t: t0 + bar * 0.5, dur: bar * 0.5, kind: 'revcym', vel: 0.5 });
    }
    // --- transition fx
    if (section === 'build') { tracks.fx.push({ t: t0, dur: bar, kind: 'riser' }); if (style !== 'lofi') tracks.fx.push({ t: t0 + bar * 0.5, dur: bar * 0.5, kind: 'revcym' }); }
    if (isDrop && k > 0 && sec[k - 1] !== section) { tracks.fx.push({ t: t0, kind: 'impact' }); tracks.fx.push({ t: t0, kind: 'crash' }); if (style !== 'lofi') tracks.fx.push({ t: t0, kind: 'subdrop' }); }
    if (section === 'break' && sec[k - 1] !== 'break') tracks.fx.push({ t: t0, dur: bar, kind: 'downlifter' });
  }
  // drops that could not become bar lines (too close together) still get a hit exactly on time
  for (const t of map.dropped) if (t < endHit - 0.2) { tracks.fx.push({ t, kind: 'impact', vel: 0.8 }); tracks.fx.push({ t, kind: 'crash', vel: 0.7 }); tracks.kick.push({ t, vel: 1, kind: 'kick' }); }
  // --- the ending: a final hit with the tonic chord ringing out
  if (ending === 'hit') {
    const t = endHit, tonic = chordOf(keyPc, mode, 0, { sevenths: style === 'lofi' }), v = voice(tonic, prevVoicing, { lo: 53, hi: 77 });
    tracks.kick.push({ t, vel: 1.1, kind: 'kick' }); tracks.clap.push({ t, vel: 0.9, kind: style === 'trap' ? 'clap' : 'snare' });
    tracks.fx.push({ t, kind: 'impact' }); tracks.fx.push({ t, kind: 'crash' });
    tracks.bass.push({ t, dur: tail * 0.9, midi: nearest(tonic.root, style === 'trap' ? 34 : 38) - (style === 'trap' ? 0 : 12), kind: style === 'trap' ? '808' : 'final', vel: 1 });
    tracks.chords.push({ t, dur: tail * 0.85, notes: v, kind: style === 'lofi' ? 'ep' : style === 'cinematic' ? 'strings' : 'final', vel: 1, section: 'end' });
    tracks.pad.push({ t, dur: tail * 0.8, notes: v, kind: 'pad', vel: 1 });
    if (style !== 'lofi') tracks.lead.push({ t, dur: tail * 0.8, midi: nearest(tonic.root, 79), vel: 0.8, kind: 'bell' });
  }
  // events before 0 s (pickup bars) are dropped by the renderer; keep the report in real time
  const beats = [];
  for (let k = 0; k < Math.min(B, ending === 'hit' ? endBar + 1 : B); k++) for (let b = 0; b < 4; b++) { const t = bars[k].t + b * bars[k].len / 4; if (t >= -1e-6 && t <= duration + 1e-6) beats.push(Math.round(t * 1000) / 1000); }
  const sections = [];
  for (let k = 0; k < Math.min(B, endBar + 1); k++) {
    const name = sec[k], start = Math.max(0, bars[k].t);
    if (start > duration) break;
    if (sections.at(-1)?.name === name) continue;
    if (sections.length) sections.at(-1).end = Math.round(start * 1000) / 1000;
    sections.push({ name, start: Math.round(start * 1000) / 1000 });
  }
  if (sections.length) sections.at(-1).end = duration;
  const anchorsOut = anchors.map(t => ({ time: Math.round(t * 1000) / 1000, bar: barOf(t) ?? null, onBar: barOf(t) !== undefined, accent: map.dropped.includes(Math.round(t * 1000) / 1000) }));
  return { style, mood: moodId, bpm: Math.round(map.bpm * 100) / 100, tempo: map.segments, key: `${NAMES[keyPc]}${mode === 'major' ? '' : 'm'}`, mode, keyPc, progression: prog,
    duration, tail, ending, endHit: ending === 'hit' ? endHit : null, anchors: anchorsOut, beats, sections, tracks, sideTimes, S };
}
