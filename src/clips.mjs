// Clip finder: long recording → the best self-contained short clips. Uses sentence boundaries
// from a transcript when there is one, otherwise scene cuts and quiet moments. Measured signals only.
import { curvesFor } from '../public/insights.js';

const STEP = 0.5;
const r3 = n => Math.round(n * 1000) / 1000;
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
function mean(curve, a, b, key = 'energy') {
  let s = 0, n = 0;
  for (let i = Math.floor(a / STEP); i < Math.ceil(b / STEP) && i < curve[key].length; i++) if (i >= 0 && curve[key][i] != null) { s += curve[key][i]; n++; }
  return n ? s / n : 0;
}

/** Sentence spans from words: break after . ! ? … or on a pause ≥ 0.7 s. */
export function sentences(words) {
  const out = []; let cur = null;
  words.forEach((w, i) => {
    if (cur && w.start - words[i - 1].end >= 0.7) { out.push(cur); cur = null; }
    if (!cur) cur = { from: i, to: i, start: w.start, end: w.end };
    cur.to = i; cur.end = w.end;
    if (/[.!?…]["”')\]]?$/.test(w.text)) { out.push(cur); cur = null; }
  });
  if (cur) out.push(cur);
  return out;
}

/** Natural boundaries without a transcript: scene cuts and starts/ends of quiet stretches. */
function boundaries(source, curve) {
  const set = new Set([0, Math.floor(source.duration * 2) / 2]);
  for (const t of source.scenes ?? []) set.add(Math.round(t * 2) / 2);
  const loud = curve.loudness;
  for (let i = 1; i < loud.length; i++) {
    const quiet = v => v != null && v < -42;
    if (quiet(loud[i - 1]) !== quiet(loud[i])) set.add(i * STEP);
  }
  return [...set].filter(t => t >= 0 && t <= source.duration).sort((a, b) => a - b);
}

/**
 * Rank candidate clips. Returns [{sourceIndex, start, end, duration, score, hook, energy, speech, complete, text, title}].
 */
export function findClips({ sources, transcripts = {}, count = 5, minSeconds = 15, maxSeconds = 60 }) {
  if (!(minSeconds >= 3 && maxSeconds >= minSeconds)) throw new Error('Use 3 ≤ minSeconds ≤ maxSeconds.');
  const curves = curvesFor(sources);
  const candidates = [];
  sources.forEach((source, sourceIndex) => {
    if (source.still || !(source.duration >= minSeconds)) return;
    const curve = curves[sourceIndex], words = transcripts[sourceIndex]?.words ?? [];
    const before = candidates.length;
    const spoken = words.length ? words.at(-1).end - words[0].start : 0;
    if (words.length >= 8) {
      const spans = sentences(words);
      for (let a = 0; a < spans.length; a++) {
        for (let b = a; b < spans.length; b++) {
          const start = Math.max(0, spans[a].start - 0.15), end = Math.min(source.duration, spans[b].end + 0.25), d = end - start;
          if (d > maxSeconds) break;
          if (d < minSeconds) continue;
          const n = spans[b].to - spans[a].from + 1, rate = n / d;
          const firstText = words.slice(spans[a].from, spans[a].to + 1).map(w => w.text).join(' ');
          const text = words.slice(spans[a].from, spans[b].to + 1).map(w => w.text).join(' ');
          const gaps = spans.slice(a + 1, b + 1).reduce((s, sp, k) => s + Math.max(0, sp.start - spans[a + k].end - 0.4), 0);
          candidates.push({ sourceIndex, start: r3(start), end: r3(end), words: n, rate, firstText, text, dead: gaps / d,
            complete: /[.!?…]["”')\]]?$/.test(words[spans[b].to].text) ? 1 : 0.6, hookBonus: /[?!]/.test(firstText) ? 0.08 : 0 });
        }
      }
    }
    // No transcript, or one that covers little of the recording: use scene/quiet boundaries too.
    if (words.length < 8 || spoken < source.duration * 0.5 || candidates.length - before < count) {
      const marks = boundaries(source, curve);
      for (let a = 0; a < marks.length; a++) for (let b = a + 1; b < marks.length; b++) {
        const d = marks[b] - marks[a];
        if (d > maxSeconds) break;
        if (d >= minSeconds) candidates.push({ sourceIndex, start: marks[a], end: marks[b], words: 0, rate: 0, text: '', firstText: '', dead: 0, complete: 0.8, hookBonus: 0 });
      }
      // Grid fallback when a recording has few natural boundaries.
      const len = Math.min(maxSeconds, Math.max(minSeconds, (minSeconds + maxSeconds) / 2));
      for (let t = 0; t + len <= source.duration; t += Math.max(2, len / 4)) candidates.push({ sourceIndex, start: r3(t), end: r3(t + len), words: 0, rate: 0, text: '', firstText: '', dead: 0, complete: 0.5, hookBonus: 0 });
    }
  });
  const scored = candidates.map(c => {
    const curve = curves[c.sourceIndex];
    const energy = mean(curve, c.start, c.end), hook = mean(curve, c.start, Math.min(c.end, c.start + 3));
    const speech = c.words ? clamp(1 - Math.abs(c.rate - 2.6) / 2.2) : 0.5;
    const black = mean({ energy: curve.black.map(x => (x ? 1 : 0)) }, c.start, c.end);
    const ideal = clamp(1 - Math.abs((c.end - c.start) - (minSeconds + maxSeconds) / 2) / maxSeconds);
    const score = 0.3 * energy + 0.25 * hook + 0.2 * speech + 0.15 * c.complete + 0.1 * ideal + c.hookBonus - c.dead * 0.5 - black;
    return { ...c, energy, hook, speech, score };
  }).sort((a, b) => b.score - a.score);
  const picked = [];
  for (const c of scored) {
    if (picked.length >= count) break;
    if (picked.some(p => p.sourceIndex === c.sourceIndex && Math.min(p.end, c.end) - Math.max(p.start, c.start) > 0)) continue;
    picked.push(c);
  }
  return picked.map((c, i) => ({
    rank: i + 1, sourceIndex: c.sourceIndex, start: c.start, end: c.end, duration: r3(c.end - c.start),
    score: Math.round(100 * clamp(c.score)), hook: Math.round(100 * c.hook), energy: Math.round(100 * c.energy), speech: c.words ? Math.round(100 * c.speech) : null,
    complete: c.complete === 1, text: c.text.slice(0, 280), title: c.firstText.replace(/\s+/g, ' ').slice(0, 70),
  }));
}
