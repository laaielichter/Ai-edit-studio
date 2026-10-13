// Director 0.9 (pure helpers): built-in LUTs, colour matching, music fitting, sound effects, audio repair
// suggestions, level matching, emphasis zooms and automatic B-roll. No FFmpeg calls here.
import { layout, LIMITS, mergeRanges } from '../public/edit-ops.js';
import { curvesFor } from '../public/insights.js';
import { wordsInEdit, bare } from '../public/transcript.js';

const r3 = n => Math.round(n * 1000) / 1000;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ------------------------------------------------------------------ LUTs
/** Built-in looks, generated as 3D LUT files (.cube) on first use. Functions map linear-ish RGB 0..1. */
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const curve = (x, k) => clamp(0.5 + (x - 0.5) * k, 0, 1); // contrast around mid-grey
const sat = (rgb, s) => { const y = luma(...rgb); return rgb.map(c => clamp(y + (c - y) * s, 0, 1)); };
export const BUILTIN_LUTS = Object.freeze({
  'teal-orange': { name: 'Teal & orange', fn: ([r, g, b]) => { const y = luma(r, g, b), w = clamp((y - 0.35) * 2, 0, 1); return sat([curve(r + 0.06 * w - 0.03 * (1 - w), 1.08), curve(g + 0.01, 1.06), curve(b - 0.06 * w + 0.06 * (1 - w), 1.08)], 1.1); } },
  'warm-film': { name: 'Warm film', fn: ([r, g, b]) => sat([clamp(0.04 + r * 0.95 + 0.03, 0, 1), clamp(0.03 + g * 0.94, 0, 1), clamp(0.05 + b * 0.86, 0, 1)].map(c => curve(c, 1.05)), 0.9) },
  'cool-night': { name: 'Cool night', fn: ([r, g, b]) => sat([curve(r * 0.88, 1.1), curve(g * 0.95 + 0.01, 1.1), curve(b * 1.02 + 0.05, 1.1)], 0.85) },
  'bleach-bypass': { name: 'Bleach bypass', fn: ([r, g, b]) => { const y = luma(r, g, b); return sat([r, g, b].map(c => curve(c * 0.6 + y * 0.4, 1.25)), 0.55); } },
  'mono-contrast': { name: 'Mono contrast', fn: ([r, g, b]) => { const y = curve(luma(r, g, b), 1.3); return [y, y, y]; } },
  'vivid-pop': { name: 'Vivid pop', fn: rgb => sat(rgb.map(c => curve(c, 1.08)), 1.35) },
});
export function cubeText(id, size = 17) {
  const lut = BUILTIN_LUTS[id]; if (!lut) throw new Error(`Unknown LUT ${id}`);
  const lines = [`TITLE "${lut.name}"`, `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0'];
  // .cube order: red changes fastest, then green, then blue.
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    lines.push(lut.fn([r / (size - 1), g / (size - 1), b / (size - 1)]).map(v => clamp(v, 0, 1).toFixed(5)).join(' '));
  }
  return `${lines.join('\n')}\n`;
}
/** Checks a .cube file before it is used: 3D size 2–65, the right number of numeric rows, values in a sane range. */
export function validateCube(text) {
  const size = Number(String(text).match(/^\s*LUT_3D_SIZE\s+(\d+)/m)?.[1]);
  if (!(size >= 2 && size <= 65)) throw new Error('Not a 3D .cube LUT (LUT_3D_SIZE 2–65 missing).');
  let rows = 0;
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || /^[A-Z][A-Z0-9_]*(\s|$)/.test(t)) continue;
    const v = t.split(/\s+/).map(Number);
    if (v.length !== 3 || v.some(x => !Number.isFinite(x) || x < -0.5 || x > 4)) throw new Error(`Invalid LUT row: ${t.slice(0, 40)}`);
    rows++;
  }
  if (rows !== size ** 3) throw new Error(`LUT has ${rows} rows; ${size ** 3} expected.`);
  return { size };
}

// ------------------------------------------------------------------ colour matching
/**
 * Per-shot correction (brightness, contrast, saturation, temperature props) from measured stats
 * {y, lo, hi, u, v, sat} (8-bit, signalstats) toward a target: another shot's stats, or "auto" (exposure
 * toward mid-grey, flat contrast opened up, colour cast removed). strength 0..1 scales the correction.
 */
export function autoTarget(s) {
  return { y: s.y + (clamp(s.y, 95, 140) - s.y) * 0.5 + (118 - clamp(s.y, 95, 140)) * 0.5, range: Math.max(s.hi - s.lo, 170), cast: 0, sat: clamp(s.sat, 22, 60) };
}
export function colorCorrection(stats, target, strength = 1) {
  const range = Math.max(8, stats.hi - stats.lo);
  const want = { y: target.y, range: target.range ?? (target.hi - target.lo), cast: target.cast ?? (target.v - target.u), sat: target.sat };
  const contrast = clamp(1 + (clamp(want.range / range, 0.7, 1.4) - 1) * strength, 0.7, 1.4);
  const predicted = ((stats.y / 255 - 0.5) * contrast + 0.5) * 255;
  const brightness = clamp(((want.y - predicted) / 255) * strength, -0.3, 0.3);
  const saturation = stats.sat < 4 ? 1 : clamp(1 + (clamp(want.sat / stats.sat, 0.5, 1.6) - 1) * strength, 0.5, 1.6);
  // Warmer (V up, U down) per unit of temperature: ~20 levels warm, ~13 cool (colortemperature, lightness kept).
  const castError = ((stats.v - stats.u) - want.cast) * strength;
  const temperature = stats.sat < 4 ? 0 : clamp(castError > 0 ? -castError / 13 : -castError / 20, -1, 1);
  const out = { brightness: r3(brightness), contrast: r3(contrast), saturation: r3(saturation), temperature: r3(temperature) };
  for (const [k, d] of [['brightness', 0], ['contrast', 1], ['saturation', 1], ['temperature', 0]]) if (Math.abs(out[k] - d) < 0.01) out[k] = d;
  return out;
}
export function averageStats(frames) {
  const keys = ['y', 'lo', 'hi', 'u', 'v', 'sat'], out = {};
  for (const k of keys) { const v = frames.map(f => f[k]).filter(Number.isFinite); out[k] = v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; }
  return out;
}

// ------------------------------------------------------------------ music to length
/**
 * Plan a remix of a track to exactly `target` seconds that keeps its real ending: whole bars are removed from
 * the middle (or a middle phrase is repeated), and the remaining fraction of a bar is skipped at the start on
 * a beat. Returns {parts:[{start,end}], trimStart, length, method}.
 */
export function musicFitPlan({ duration, beats = [], downbeatIndex = 0, bpm = 0, target, crossfade = 0.06 }) {
  if (!(target > 1) || !(duration > 1)) throw new Error('Music and edit need a length.');
  const beat = bpm > 30 ? 60 / bpm : beats.length > 4 ? (beats.at(-1) - beats[0]) / (beats.length - 1) : 0;
  const bars = beats.length > 8 ? beats.filter((_, k) => (k - downbeatIndex) % 4 === 0 && k >= downbeatIndex) : [];
  const bar = beat * 4;
  if (Math.abs(duration - target) < 0.3) return { parts: [{ start: 0, end: duration }], trimStart: 0, length: duration, method: 'already fits' };
  if (bars.length < 6 || !(bar > 0.5)) {
    // No reliable beat grid: one long crossfade in the middle.
    if (duration > target) { const a = target * 0.45, b = a + (duration - target) + 1; return { parts: [{ start: 0, end: a + 1 }, { start: b - 1, end: duration }], trimStart: 0, crossfade: 1, length: target, method: 'crossfade (no beat grid)' }; }
    const loops = Math.ceil((target - duration) / (duration * 0.5)) + 1;
    const parts = [{ start: 0, end: duration * 0.75 }];
    for (let k = 0; k < loops; k++) parts.push({ start: duration * 0.25, end: duration * 0.75 });
    parts.push({ start: duration * 0.75, end: duration });
    const length = parts.reduce((s, p) => s + p.end - p.start, 0) - (parts.length - 1);
    return { parts, trimStart: Math.max(0, length - target), crossfade: 1, length: target, method: 'loop (no beat grid)' };
  }
  const nearestBar = t => bars.reduce((best, b) => (Math.abs(b - t) < Math.abs(best - t) ? b : best), bars[0]);
  if (duration > target) {
    const removeBars = Math.floor((duration - target) / bar);
    const rest = (duration - removeBars * bar) - target; // 0 ≤ rest < bar, skipped at the start on a beat
    const skip = beats.length ? beats.reduce((best, b) => (b <= rest + beat / 2 && b >= best ? b : best), 0) : 0;
    if (!removeBars) return { parts: [{ start: 0, end: duration }], trimStart: r3(skip), length: r3(duration - skip), method: 'start on a beat' };
    // Cut where the music is past its intro: ~40% into what remains, on a bar line.
    const a = nearestBar(Math.max(bars[1], (target * 0.4) + skip));
    const b = a + removeBars * bar;
    const bLine = nearestBar(b);
    const end = Math.abs(bLine - b) < beat / 2 ? bLine : b;
    return { parts: [{ start: 0, end: r3(a) }, { start: r3(end), end: duration }], trimStart: r3(skip), crossfade, length: r3(duration - (end - a) - skip), method: `removed ${removeBars} bar(s)` };
  }
  // Shorter: repeat a middle phrase of 4–8 bars until long enough.
  const phraseBars = bars.length >= 16 ? 8 : 4;
  const i0 = Math.floor(bars.length / 2) - Math.floor(phraseBars / 2), p0 = bars[Math.max(1, i0)], p1 = p0 + phraseBars * bar;
  if (p1 >= duration - bar) return musicFitPlan({ duration, beats: [], target, crossfade });
  const missing = target - duration, repeats = Math.ceil(missing / (p1 - p0));
  const parts = [{ start: 0, end: r3(p1) }];
  for (let k = 0; k < repeats - 1; k++) parts.push({ start: r3(p0), end: r3(p1) });
  parts.push({ start: r3(p0), end: duration });
  const length = parts.reduce((s, p) => s + p.end - p.start, 0);
  const extra = length - target;
  const skip = beats.length ? beats.reduce((best, b) => (b <= extra + beat / 2 && b >= best ? b : best), 0) : 0;
  return { parts, trimStart: r3(skip), crossfade, length: r3(length - skip), method: `repeated a ${phraseBars}-bar phrase ${repeats}×` };
}

// ------------------------------------------------------------------ sound effects
/** Locally synthesised effects (FFmpeg lavfi descriptions); no samples are downloaded. */
export const SFX = Object.freeze({
  whoosh: { name: 'Whoosh', seconds: 0.7, graph: "anoisesrc=d=0.7:c=pink:a=0.9:seed=4,highpass=f=350,lowpass=f=5200,volume='if(lt(t,0.42),pow(t/0.42,2),pow(max(0,(0.7-t)/0.28),1.5))':eval=frame,aphaser=in_gain=0.6:out_gain=0.9:delay=2:decay=0.4:speed=1.6" },
  hit: { name: 'Hit', seconds: 1.1, graph: "aevalsrc='0.95*sin(2*PI*52*t)*exp(-5*t)+0.5*sin(2*PI*104*t)*exp(-9*t)+0.35*sin(2*PI*31*t)*exp(-3*t)':d=1.1:s=48000" },
  pop: { name: 'Pop', seconds: 0.22, graph: "aevalsrc='0.8*sin(2*PI*(520+1600*exp(-30*t))*t)*exp(-16*t)':d=0.22:s=48000" },
  riser: { name: 'Riser', seconds: 1.8, graph: "aevalsrc='0.35*sin(2*PI*(180+520*t*t)*t)*pow(t/1.8,2)':d=1.8:s=48000" },
  click: { name: 'Click', seconds: 0.08, graph: "aevalsrc='0.7*sin(2*PI*2400*t)*exp(-90*t)':d=0.08:s=48000" },
  drop: { name: 'Drop', seconds: 0.9, graph: "aevalsrc='0.6*sin(2*PI*(900*exp(-4*t)+60)*t)*exp(-3*t)':d=0.9:s=48000" },
});
export function normalizeSfx(rows = []) {
  if (!Array.isArray(rows) || rows.length > 300) throw new Error('At most 300 sound effects.');
  return rows.map((r, i) => {
    const time = Number(r.time), gain = r.gain === undefined ? 0.7 : Number(r.gain);
    if (!SFX[r.kind]) throw new Error(`Sound effect ${i + 1}: kind ${Object.keys(SFX).join('/')}.`);
    if (!Number.isFinite(time) || time < 0 || time > LIMITS.editSeconds) throw new Error(`Sound effect ${i + 1}: invalid time.`);
    if (!Number.isFinite(gain) || gain < 0 || gain > 2) throw new Error(`Sound effect ${i + 1}: gain 0–2.`);
    return { time: r3(time), kind: r.kind, gain: r3(gain) };
  }).sort((a, b) => a.time - b.time);
}
/** Effects on edit events: whoosh into transitions, pop on texts, hit on punch-ins and the finale, riser before it. */
export function autoSfx({ clips, options = {}, kinds = ['whoosh', 'pop', 'hit', 'riser'], gain = 0.7, minGap = 0.45 }) {
  const rows = layout(clips), out = [];
  const add = (time, kind, g = gain) => { if (kinds.includes(kind) && time >= 0 && !out.some(x => Math.abs(x.time - time) < minGap)) out.push({ time: r3(time), kind, gain: g }); };
  for (const r of rows) if (r.index && r.transition && r.transition !== 'cut') add(Math.max(0, r.timelineStart + r.overlapIn / 2 - SFX.whoosh.seconds * 0.6), 'whoosh');
  for (const r of rows) {
    const prev = rows[r.index - 1];
    if (prev && prev.sourceIndex === r.sourceIndex && Math.abs(prev.end - r.start) < 0.05 && Math.abs((r.zoom ?? 1) - (prev.zoom ?? 1)) > 0.05) add(r.timelineStart, 'hit', gain * 0.6);
  }
  for (const t of options.texts ?? []) add(t.start, 'pop', gain * 0.8);
  const total = rows.at(-1)?.timelineEnd ?? 0, last = rows.at(-1);
  if (last && rows.length > 3 && total > 12) { add(Math.max(0, last.visibleStart - SFX.riser.seconds), 'riser', gain * 0.8); add(last.visibleStart, 'hit'); }
  return out.sort((a, b) => a.time - b.time).slice(0, 300);
}

// ------------------------------------------------------------------ audio repair
/** Suggestions from measurements: {bands:{50,60,ref}, peak, clipped, noiseFloor} per source. */
export function audioRepairAdvice(m) {
  const hum = m.bands ? (m.bands[50] - m.bands.ref > 8 && m.bands[50] - m.bands[60] > 3 ? 50 : m.bands[60] - m.bands.ref > 8 && m.bands[60] - m.bands[50] > 3 ? 60 : 0) : 0;
  return { hum, declip: Boolean(m.clipped > 20 || m.peak > -0.05), declick: false, denoise: m.noiseFloor > -52 ? clamp(r3((m.noiseFloor + 60) / 30), 0.2, 0.6) : 0 };
}
export function normalizeAudioRepair(v) {
  if (v === null || v === undefined || v === false) return null;
  if (typeof v !== 'object') throw new Error('audioRepair: {hum, declick, declip, denoise}.');
  const hum = Number(v.hum ?? 0), denoise = Number(v.denoise ?? 0);
  if (![0, 50, 60].includes(hum)) throw new Error('audioRepair.hum: 0, 50 or 60.');
  if (!(denoise >= 0 && denoise <= 1)) throw new Error('audioRepair.denoise: 0–1.');
  const out = { hum, declick: Boolean(v.declick), declip: Boolean(v.declip), denoise: r3(denoise) };
  return out.hum || out.declick || out.declip || out.denoise ? out : null;
}
/** Numeric-only FFmpeg chain for the programme sound. */
export function audioRepairChain(v) {
  const r = normalizeAudioRepair(v); if (!r) return '';
  const parts = [];
  if (r.declip) parts.push('adeclip');
  if (r.declick) parts.push('adeclick');
  if (r.hum) for (let k = 1; k <= 4; k++) parts.push(`bandreject=f=${r.hum * k}:width_type=q:w=${18 + 6 * k}`);
  if (r.denoise) parts.push(`afftdn=nr=${(6 + 18 * r.denoise).toFixed(1)}:nf=-${(50 - 12 * r.denoise).toFixed(1)}:tn=1`);
  return `${parts.join(',')},`;
}
/** Even out shot loudness (dialogue/game levels from the analysis) with per-shot gain. */
export function levelMatch(clips, sources, { maxBoost = 2, maxCut = 0.5 } = {}) {
  const curves = curvesFor(sources), levels = [];
  for (const c of clips) {
    if ((c.gain ?? 1) === 0) continue;
    const loud = curves[c.sourceIndex]?.loudness ?? [];
    const vals = []; for (let i = Math.floor(c.start / 0.5); i < Math.ceil(c.end / 0.5) && i < loud.length; i++) if (loud[i] != null && loud[i] > -60) vals.push(loud[i]);
    if (vals.length) levels.push({ id: c.id, level: vals.sort((a, b) => a - b)[Math.floor(vals.length * 0.6)], gain: c.gain ?? 1 });
  }
  if (levels.length < 2) return [];
  const target = [...levels].map(l => l.level).sort((a, b) => a - b)[Math.floor(levels.length / 2)];
  return levels.map(l => ({ clip: l.id, gain: r3(clamp(10 ** ((target - l.level) / 20), maxCut, maxBoost)) })).filter(x => Math.abs(20 * Math.log10(x.gain)) > 1.5);
}

/** Quiet stretches of a recording from the analysis loudness (0.5 s steps): [{start, end}] in source seconds. */
export function quietRanges(source, { min = 1.2, thresholdDb = -42, keep = 0.15 } = {}) {
  const loud = curvesFor([source])[0].loudness, out = [];
  let a = null;
  for (let i = 0; i <= loud.length; i++) {
    const quiet = i < loud.length && (loud[i] == null || loud[i] < thresholdDb);
    if (quiet && a == null) a = i * 0.5;
    if (!quiet && a != null) { const b = i * 0.5; if (b - a >= min) out.push({ start: r3(a + keep), end: r3(Math.min(source.duration, b) - keep) }); a = null; }
  }
  return out.filter(r => r.end - r.start >= 0.5);
}

// ------------------------------------------------------------------ emphasis zooms (talking heads)
/** Timeline moments worth a zoom change: sentence starts, '!'/'?' words, and loud peaks; ≥ minGap apart. */
export function emphasisTimes({ clips, sources, transcripts = {}, minGap = 2.5 }) {
  const rows = layout(clips), curves = curvesFor(sources), out = [];
  for (const [key, t] of Object.entries(transcripts)) {
    const si = Number(key); if (!t?.words?.length) continue;
    const marked = wordsInEdit(t.words, clips, si);
    t.words.forEach((w, i) => {
      if (!marked[i].inEdit) return;
      const prev = t.words[i - 1];
      const start = !prev || /[.!?]$/.test(prev.text) || w.start - prev.end > 0.6;
      if (start || /[!?]$/.test(w.text)) out.push({ time: marked[i].timeline, weight: /[!?]$/.test(w.text) ? 2 : 1 });
    });
  }
  if (!out.length) {
    for (const r of rows) {
      const loud = curves[r.sourceIndex]?.loudness ?? [];
      for (let s = r.start + 1; s < r.end - 1; s += 0.5) {
        const v = loud[Math.floor(s / 0.5)], before = loud[Math.floor((s - 1) / 0.5)];
        if (v != null && before != null && v - before > 6) out.push({ time: r.timelineStart + (s - r.start) / (r.speed || 1), weight: 1 });
      }
    }
  }
  out.sort((a, b) => a.time - b.time || b.weight - a.weight);
  const picked = [];
  for (const e of out) if (!picked.length || e.time - picked.at(-1) >= minGap) picked.push(r3(e.time));
  return picked;
}

// ------------------------------------------------------------------ automatic B-roll
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'clip', 'video', 'footage', 'final', 'copy', 'take', 'img', 'mov', 'mp4', 'dji', 'gopro', 'broll', 'b-roll', 'een', 'het', 'de', 'van', 'met']);
export function nameTokens(name) {
  return [...new Set(String(name ?? '').replace(/\.[a-z0-9]{2,4}$/i, '').split(/[^\p{L}\p{N}]+/u).map(t => bare(t)).filter(t => t.length >= 3 && !/^\d+$/.test(t) && !STOP.has(t)))];
}
const near = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && (a.startsWith(b) || b.startsWith(a)));
/**
 * B-roll layers over the edit: where a spoken word matches a B-roll source's name (or label), else spread over the
 * calmest stretches. Picks each B-roll's strongest unused window. Returns overlay rows + how each was chosen.
 */
export function autoBrollPlan({ clips, sources, options = {}, transcripts = {}, pool, seconds = 3, maxPerMinute = 4, mode = 'full', gain = 0, labels = {} }) {
  const rows = layout(clips), total = rows.at(-1)?.timelineEnd ?? 0, curves = curvesFor(sources);
  const used = new Set(clips.map(c => c.sourceIndex));
  const candidates = (pool?.length ? pool : sources.map((_, i) => i).filter(i => !used.has(i))).filter(i => sources[i] && sources[i].duration >= Math.min(seconds, 1.5) + 0.2);
  if (!candidates.length) return { overlays: [], method: 'none', note: 'Add B-roll recordings to the project (sources not used in the edit), or name them in pool.' };
  const busy = (options.overlays ?? []).map(o => [o.at - 0.5, o.at + (o.end - o.start) + 0.5]);
  const free = t => t > 2 && t + seconds < total - 3 && !busy.some(([a, b]) => t < b && t + seconds > a);
  const takenBy = new Map(); // sourceIndex → used [start,end] ranges
  const window = si => {
    const e = curves[si]?.energy ?? [], d = Math.min(seconds, sources[si].duration - 0.1), taken = takenBy.get(si) ?? [];
    let best = null;
    for (let a = 0; a + d <= sources[si].duration - 0.05; a += 0.5) {
      if (taken.some(([x, y]) => a < y && a + d > x)) continue;
      let s = 0, n = 0; for (let i = Math.floor(a / 0.5); i < Math.ceil((a + d) / 0.5); i++) if (e[i] != null) { s += e[i]; n++; }
      const score = n ? s / n : 0.3;
      if (!best || score > best.score) best = { start: r3(a), end: r3(a + d), score };
    }
    if (best) takenBy.set(si, [...taken, [best.start, best.end]]);
    return best;
  };
  const tokens = new Map(candidates.map(i => [i, [...nameTokens(sources[i].name ?? sources[i].file), ...nameTokens(labels[i])]]));
  const spacing = 60 / Math.max(0.5, maxPerMinute), placed = [];
  const room = t => free(t) && !placed.some(p => Math.abs(p.at - t) < Math.max(spacing * 0.6, seconds + 1));
  // 1. Spoken keywords.
  for (const [key, tr] of Object.entries(transcripts)) {
    const si = Number(key); if (!tr?.words?.length) continue;
    const marked = wordsInEdit(tr.words, clips, si);
    tr.words.forEach((w, i) => {
      if (!marked[i].inEdit) return;
      const k = bare(w.text); if (k.length < 3) return;
      const hit = candidates.find(c => tokens.get(c).some(t => near(t, k)));
      const at = marked[i].timeline - 0.15;
      if (hit == null || !room(at)) return;
      const win = window(hit); if (!win) return;
      placed.push({ sourceIndex: hit, start: win.start, end: win.end, at: r3(Math.max(0, at)), why: `said "${w.text}"` });
    });
  }
  // 2. Calm stretches (talking heads, lulls), spread evenly, B-roll sources taken in turn.
  if (placed.length < Math.floor(total / 60 * maxPerMinute * 0.5)) {
    let k = 0;
    for (let t = Math.max(4, spacing / 2); t < total - seconds - 3; t += spacing) {
      let bestT = null, bestE = Infinity;
      for (let x = t - spacing / 3; x <= t + spacing / 3; x += 0.5) {
        if (!room(x)) continue;
        const r = rows.find(row => x >= row.visibleStart && x < row.visibleEnd); if (!r) continue;
        const e = curves[r.sourceIndex]?.energy?.[Math.floor((r.start + (x - r.timelineStart) * (r.speed || 1)) / 0.5)] ?? 0.5;
        if (e < bestE) { bestE = e; bestT = x; }
      }
      if (bestT == null) continue;
      const si = candidates[k++ % candidates.length], win = window(si); if (!win) continue;
      placed.push({ sourceIndex: si, start: win.start, end: win.end, at: r3(bestT), why: 'calm stretch' });
    }
  }
  placed.sort((a, b) => a.at - b.at);
  return { overlays: placed.slice(0, 50).map(({ why, ...p }) => ({ ...p, mode, gain, fade: 0.2, ...(mode === 'pip' ? { position: 'top-right', size: 0.32 } : {}) })),
    reasons: placed.slice(0, 50).map(p => ({ at: p.at, sourceIndex: p.sourceIndex, why: p.why })), method: placed.some(p => p.why.startsWith('said')) ? 'keywords' : 'calm stretches' };
}
export { mergeRanges };
