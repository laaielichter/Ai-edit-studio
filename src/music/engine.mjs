// Music engine: renders a composed score into a mixed, mastered stereo track (and optional stems).
import { SR, rng, stereo, mixInto, secs, midiHz, eq, reverb, pingPong, compress, limit, pump, gain, addInto, lufs, peakDb, saturate, svfProcess, Biquad, wav24, chorus, stereoWidth, tonalBalance, bandLevels } from './dsp.mjs';
import * as I from './instruments.mjs';
import { compose, STYLES, styleList, MOODS } from './compose.mjs';

export { styleList, STYLES, MOODS };
export const MUSIC_ENGINE_VERSION = 1;

const cacheKey = (...a) => JSON.stringify(a);

/** Render one track's events into a stereo buffer (instrument choice per style and event kind). */
function renderTrack(name, events, score, n, r) {
  const out = stereo(n), style = score.style, cache = new Map();
  const once = (key, make) => { if (!cache.has(key)) cache.set(key, make()); return cache.get(key); };
  const at = t => Math.round(t * SR);
  const variant = (key, count, make) => once(cacheKey(key, Math.floor(r() * count)), make);
  for (const e of events) {
    const v = e.vel ?? 1;
    switch (name) {
      case 'kick': {
        const kp = { pop: { decay: 0.3, tone: 50, drive: 1.7 }, trap: { decay: 0.22, tone: 55, start: 260, drive: 2 }, house: { decay: 0.26, tone: 52, drive: 1.6 },
          lofi: { decay: 0.2, tone: 56, click: 0.25, drive: 1.3, start: 160 }, synthwave: { decay: 0.3, tone: 52, drive: 1.5 }, cinematic: { decay: 0.45, tone: 44, drive: 2.2, start: 200 } }[style];
        mixInto(out, once('kick', () => { const k = I.kick(r, kp); if (style === 'lofi') new Biquad('lp', 2600).run(k); return k; }), at(e.t), v * 0.9);
        break;
      }
      case 'clap': {
        const kind = e.kind;
        const buf = kind === 'clap' ? variant('clap', 3, () => I.clap(r, { tone: style === 'trap' ? 1250 : 1100 }))
          : variant('snare' + style, 3, () => { const s = I.snare(r, { tone: style === 'lofi' ? 210 : 190, snappy: style === 'lofi' ? 0.55 : 0.8, decay: style === 'synthwave' ? 0.2 : 0.15 }); if (style === 'lofi') new Biquad('lp', 5000).run(s); return s; });
        mixInto(out, buf, at(e.t), v * (kind === 'clap' ? 0.8 : 0.85), kind === 'snare' && style === 'trap' ? 0.05 : 0);
        break;
      }
      case 'hats': {
        const buf = e.kind === 'open' ? variant('ohat', 2, () => I.hat(r, { open: true, decay: style === 'house' ? 0.16 : 0.24 })) : variant('hat' + style, 4, () => I.hat(r, { decay: style === 'lofi' ? 0.05 : 0.032, tone: 1 + (r() - 0.5) * 0.06 }));
        mixInto(out, buf, at(e.t), v * (e.kind === 'open' ? 0.55 : 0.5), e.kind === 'open' ? -0.2 : 0.22);
        break;
      }
      case 'perc': {
        const kind = e.kind;
        const buf = kind === 'rim' ? once('rim', () => I.rim(r)) : kind === 'taiko' ? variant('taiko', 3, () => I.tom(r, { tone: 70 + r() * 18, decay: 0.55 })) : kind === 'cowbell' ? once('cow', () => I.cowbell(r)) : variant('shaker', 3, () => I.shaker(r));
        mixInto(out, buf, at(e.t), v * (kind === 'taiko' ? 1 : 0.6), kind === 'shaker' ? -0.3 : kind === 'rim' ? 0.15 : (r() - 0.5) * 0.3);
        break;
      }
      case 'bass': {
        const f = midiHz(e.midi);
        if (e.kind === '808') mixInto(out, I.sub808(r, { freq: f, dur: e.dur, glideFrom: e.glideFrom ? midiHz(e.glideFrom) : null }), at(e.t), v);
        else if (e.kind === 'final') { mixInto(out, I.sub808(r, { freq: f, dur: e.dur, drive: 1.4, decay: e.dur * 0.6 }), at(e.t), v * 0.8); mixInto(out, I.bass(r, { freq: f * 2, dur: e.dur * 0.6, style: 'sustain' }), at(e.t), v * 0.5); }
        else mixInto(out, once(cacheKey('b', e.kind, e.midi, Math.round(e.dur * 100), Math.round(v * 10)), () => I.bass(r, { freq: f, dur: e.dur, style: e.kind, vel: v })), at(e.t), v);
        break;
      }
      case 'chords': {
        for (const m of e.notes) {
          const f = midiHz(m), d = e.dur;
          let buf;
          if (e.kind === 'saw') buf = once(cacheKey('saw', m, Math.round(d * 100)), () => I.supersaw(r, { freq: f, dur: d, decay: 0.32, sustain: 0.55, cutoff: 4200, envAmt: 1.4 }));
          else if (e.kind === 'sawbuild') { buf = I.supersaw(r, { freq: f, dur: d, attack: 0.05, sustain: 0.9, cutoff: 900, envAmt: 0 }); for (const ch of [buf.L, buf.R]) svfProcess(ch, { type: 'lp', q: 1.1, cutoff: t => 500 * (9000 / 500) ** Math.min(1, t / d) }); }
          else if (e.kind === 'final') { buf = I.supersaw(r, { freq: f, dur: d, attack: 0.003, sustain: 0.6, decay: 1.2, release: 0.9, cutoff: 5200, envAmt: 0.8 }); }
          else if (e.kind === 'stab') buf = once(cacheKey('stab', m, Math.round(d * 100)), () => I.synth({ freq: f, dur: d, waves: [{ type: 'saw', gain: 0.8 }, { type: 'square', gain: 0.5, octave: 1 }], unison: { voices: 3, detune: 10, spread: 0.6 }, filter: { cutoff: 900, q: 1.2, envAmt: 2.4, env: { a: 0.001, d: 0.12, s: 0.1, r: 0.08 } }, amp: { a: 0.002, d: 0.18, s: 0.4, r: 0.08 } }, r));
          else if (e.kind === 'pianoish') buf = I.piano(r, { freq: f, dur: d, vel: 0.7 });
          else if (e.kind === 'ep') buf = I.ep(r, { freq: f, dur: d, vel: 0.55 + 0.35 * v });
          else if (e.kind === 'darkpad') buf = I.pad(r, { freq: f, dur: d, warm: 0.6, attack: 0.25, release: 0.6 });
          else if (e.kind === 'strings') buf = I.strings(r, { freq: f, dur: d, attack: 0.3, release: 0.9 });
          else if (e.kind === 'spiccato') buf = once(cacheKey('spic', m), () => I.strings(r, { freq: f, dur: d, attack: 0.008, release: 0.08 }));
          else if (e.kind === 'brass') buf = I.brass(r, { freq: f, dur: d });
          else buf = I.pad(r, { freq: f, dur: d, warm: style === 'synthwave' ? 1.3 : 1, attack: 0.15, release: 0.5 });
          mixInto(out, buf, at(e.t), v / Math.sqrt(e.notes.length));
        }
        break;
      }
      case 'pad': {
        for (const m of e.notes) {
          const buf = e.kind === 'choirpad' ? (() => { const p = I.pad(r, { freq: midiHz(m), dur: e.dur, warm: 1.1, attack: 0.6, release: 1 }); for (const ch of [p.L, p.R]) { new Biquad('peak', 700, 1.4, 6).run(ch); new Biquad('peak', 1150, 2, 4).run(ch); } return p; })()
            : I.pad(r, { freq: midiHz(m), dur: e.dur + 0.3, warm: style === 'lofi' ? 0.6 : 1, attack: 0.45, release: 1.1 });
          mixInto(out, buf, at(e.t), (e.vel ?? 1) / Math.sqrt(e.notes.length));
        }
        break;
      }
      case 'lead': {
        const f = midiHz(e.midi);
        let buf;
        if (e.kind === 'pluck') buf = once(cacheKey('pl', e.midi, Math.round(e.dur * 50)), () => I.pluck(r, { freq: f, dur: e.dur, decay: 0.3 }));
        else if (e.kind === 'arp') buf = once(cacheKey('arp', e.midi), () => I.pluck(r, { freq: f, dur: e.dur, decay: 0.16, bright: 0.8 }));
        else if (e.kind === 'bell' || e.kind === 'bellsoft') buf = once(cacheKey('bell', e.midi, e.kind), () => I.bell(r, { freq: f, dur: e.dur, ratio: style === 'trap' ? 3.5 : 2, ring: e.kind === 'bellsoft' ? 0.9 : 1.2, vel: e.kind === 'bellsoft' ? 0.5 : 0.8 }));
        else if (e.kind === 'piano') buf = I.piano(r, { freq: f, dur: e.dur, vel: 0.8 });
        else buf = I.lead(r, { freq: f, dur: e.dur });
        mixInto(out, buf, at(e.t), v * (e.kind === 'arp' ? 0.45 : 1), e.kind === 'arp' ? (r() - 0.5) * 0.6 : 0);
        break;
      }
      case 'fx': {
        const buf = e.kind === 'riser' ? I.riser(r, { dur: e.dur }) : e.kind === 'revcym' ? I.revCymbal(r, { dur: e.dur }) : e.kind === 'impact' ? once('impact', () => I.impact(r))
          : e.kind === 'crash' ? once('crash', () => I.crash(r)) : e.kind === 'subdrop' ? once('subdrop', () => I.subDrop(r)) : e.kind === 'downlifter' ? I.downlifter(r, { dur: e.dur }) : null;
        if (buf) mixInto(out, buf, at(e.t), ({ riser: 0.7, revcym: 0.5, impact: 0.9, crash: 0.45, subdrop: 0.8, downlifter: 0.5 }[e.kind] ?? 0.6) * (e.vel ?? 1));
        break;
      }
      default: break;
    }
  }
  return out;
}

const TRACK_EQ = {
  kick: [['hp', 30, 0.7]],
  clap: [['hp', 220, 0.7], ['peak', 3500, 1, 1.5]],
  hats: [['hp', 600, 0.7]],
  perc: [['hp', 140, 0.7]],
  bass: [['hp', 30, 0.7], ['lp', 5000, 0.7]],
  chords: [['hp', 170, 0.7], ['peak', 400, 0.9, -2]],
  pad: [['hp', 220, 0.7], ['lp', 9000, 0.7]],
  lead: [['hp', 260, 0.7], ['peak', 2600, 1, 1.5]],
  fx: [['hp', 35, 0.7]],
};
const SENDS = { // [reverb, delay]
  clap: [0.22, 0], hats: [0.06, 0], perc: [0.12, 0], chords: [0.2, 0.06], pad: [0.4, 0], lead: [0.2, 0.22], fx: [0.25, 0],
};

/** Loudness of the active part of a track (gated LUFS), or null when silent. */
function trackLoudness(buf) { const l = lufs(buf); return l > -69 ? l : null; }

/**
 * generateMusic(spec) → { wav: Buffer, stems?: {name: Buffer}, report }
 * spec: { style, mood, duration, drops, ending, seed, key, bpm, intensity, stems }
 */
export function generateMusic(spec = {}) {
  const started = Date.now();
  const score = compose(spec), S = score.S, r = rng((Number(spec.seed ?? 1) >>> 0) * 31 + 7);
  const n = Math.round(score.duration * SR), work = n + secs(4);
  const tracks = {};
  for (const [name, events] of Object.entries(score.tracks)) {
    if (!events.length) continue;
    const buf = renderTrack(name, events, score, work, r);
    eq(buf, TRACK_EQ[name] ?? []);
    if (name === 'clap' && style(score) === 'synthwave') gatedVerb(buf, events);
    tracks[name] = buf;
  }
  // texture
  if (score.style === 'lofi') tracks.fx = addInto(tracks.fx ?? stereo(work), I.vinyl(r, { dur: work / SR }), 1);
  // auto-balance each track to the style's loudness recipe (measured, not guessed)
  const levels = {};
  for (const [name, buf] of Object.entries(tracks)) {
    const l = trackLoudness(buf), target = S.mix[name] ?? -18;
    if (l === null) continue;
    const g = 10 ** ((target - l) / 20) * (spec.intensity !== undefined && (name === 'kick' || name === 'clap') ? 0.85 + 0.3 * spec.intensity : 1);
    gain(buf, g); levels[name] = Math.round(target * 10) / 10;
  }
  // sidechain pump (EDM styles) keyed by the kicks in the main sections
  if (S.sidechain > 0) for (const name of ['bass', 'chords', 'pad', 'lead']) if (tracks[name]) pump(tracks[name], score.sideTimes, { depth: S.sidechain * (name === 'lead' ? 0.4 : name === 'bass' ? 1.1 : 1), release: Math.min(0.32, 60 / score.bpm * 0.62) });
  if (tracks.pad) chorus(tracks.pad, { mix: 0.35 });
  if (tracks.chords && (score.style === 'pop' || score.style === 'synthwave')) stereoWidth(tracks.chords, 1.25);
  // buses
  const mix = stereo(work), rvIn = stereo(work), dlIn = stereo(work);
  for (const [name, buf] of Object.entries(tracks)) {
    addInto(mix, buf, 1);
    const [rv, dl] = SENDS[name] ?? [0, 0];
    if (rv) addInto(rvIn, buf, rv);
    if (dl) addInto(dlIn, buf, dl);
  }
  const drums = stereo(work);
  for (const name of ['kick', 'clap', 'hats', 'perc']) if (tracks[name]) addInto(drums, tracks[name], 1);
  const beat = 60 / score.bpm;
  const dly = pingPong(dlIn, { time: S.delay * beat, feedback: 0.36, hp: 400, lp: 5000 });
  addInto(rvIn, dly, 0.25);
  const rev = reverb(rvIn, { ...S.reverb, damp: score.style === 'lofi' ? 4000 : 6500, pre: 0.018 });
  eq(rev, [['hp', 260, 0.7], ['lp', 10000, 0.7]]);
  const busLevels = { dry: Math.round(lufs(mix) * 10) / 10, reverb: Math.round(lufs(rev) * 10) / 10, delay: Math.round(lufs(dly) * 10) / 10 };
  addInto(mix, dly, 0.8); addInto(mix, rev, { pop: 1.4, trap: 1.2, house: 1.1, lofi: 1, synthwave: 1.5, cinematic: 1.3 }[score.style] ?? 1.2);
  // master: tone, glue, colour, loudness, ceiling
  const master = mix;
  eq(master, [['hp', 24, 0.7]]);
  if (score.style === 'lofi') eq(master, [['lp', 9000, 0.6]]);
  // tonal balance measured over the main (loudest) sections only
  const main = score.sections.filter(s => s.name === 'drop' || s.name === 'drop2');
  const span = main.length ? { from: main[0].start, to: main.at(-1).end } : {};
  const tonal = tonalBalance(master, S.tonal, { amount: 0.7, max: 4.5, passes: 3, ...span });
  compress(master, { threshold: -14, ratio: 2, attack: 0.012, release: 0.15, knee: 8 });
  for (const ch of [master.L, master.R]) saturate(ch, 1.08, 0.5);
  // the end: cut exactly at the requested length with a short fade after the ring-out
  const fadeLen = secs(Math.min(0.6, Math.max(0.15, score.tail * 0.35)));
  const cut = b => { const o = stereo(n); for (let i = 0; i < n; i++) { o.L[i] = b.L[i]; o.R[i] = b.R[i]; } for (let i = 0; i < fadeLen; i++) { const g = (i / fadeLen) ** 1.5; o.L[n - 1 - i] *= g; o.R[n - 1 - i] *= g; } return o; };
  const fin = cut(master);
  for (let pass = 0; pass < 2; pass++) { const l = lufs(fin); gain(fin, 10 ** ((S.master - l) / 20)); limit(fin, { ceiling: -1, release: 0.06 }); }
  const result = { wav: wav24(fin) };
  if (spec.stems) {
    // stems are pre-master (no EQ/compression/limiting), scaled together so the loudest one peaks at -1 dBFS
    const raw = spec.stems === 'tracks' ? Object.fromEntries(Object.keys(tracks).map(k => [k, [k]])) : { drums: ['kick', 'clap', 'hats', 'perc'], bass: ['bass'], music: ['chords', 'pad', 'lead'], fx: ['fx'] };
    const bufs = Object.fromEntries(Object.entries(raw).map(([k, names]) => { const s = stereo(work); for (const nm of names) if (tracks[nm]) addInto(s, tracks[nm], 1); return [k, cut(s)]; }));
    const pk = Math.max(...Object.values(bufs).map(b => peakDb(b)));
    result.stems = Object.fromEntries(Object.entries(bufs).map(([k, b]) => [k, wav24(gain(b, 10 ** ((-1 - pk) / 20)))]));
  }
  result.report = {
    engine: MUSIC_ENGINE_VERSION, style: score.style, mood: score.mood, key: score.key, bpm: score.bpm, duration: score.duration, ending: score.ending, endHit: score.endHit,
    anchors: score.anchors, tempo: score.tempo, beats: score.beats, sections: score.sections,
    downbeats: score.beats.filter((_, i) => i % 4 === 0), progression: score.progression, levels, tonal, busLevels, loudness: Math.round(lufs(fin) * 10) / 10, peak: Math.round(peakDb(fin) * 10) / 10,
    seconds: Math.round((Date.now() - started) / 100) / 10,
  };
  return result;
}
const style = score => score.style;
/** 80s gated reverb on the snare: big room, cut off sharply 200 ms after each hit. */
function gatedVerb(buf, events) {
  const wet = reverb(buf, { decay: 2.6, size: 1.3, pre: 0.005, hp: 300 });
  const n = buf.L.length, gate = new Float32Array(n);
  for (const e of events) { const s = Math.round(e.t * SR); for (let i = 0; i < secs(0.24); i++) { const j = s + i; if (j < n) gate[j] = Math.max(gate[j], i < secs(0.2) ? 1 : 1 - (i - secs(0.2)) / secs(0.04)); } }
  for (let i = 0; i < n; i++) { buf.L[i] += wet.L[i] * gate[i] * 0.9; buf.R[i] += wet.R[i] * gate[i] * 0.9; }
}
