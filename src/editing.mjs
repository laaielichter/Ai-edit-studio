import { normalizeSfx, normalizeAudioRepair } from './polish.mjs';
import path from 'node:path';
import { StudioError } from './paths.mjs';
import { buildTrailerPlan } from './planner.mjs';
import { normalizeFinish, normalizeTransform, normalizeTransition, normalizeColor } from './finishing.mjs';
import { normalizeCaptions } from '../public/captions.js';
import { newClipId, LIMITS, overlapOf, normalizeTexts, normalizeOverlays, normalizeSections } from '../public/edit-ops.js';

export const EXPORT_PRESETS = Object.freeze({
  landscape: { name: 'Widescreen', resolution: '1920x1080', fps: 60 },
  vertical: { name: 'Vertical', resolution: '1080x1920', fps: 30, vertical: true },
  whatsapp: { name: 'WhatsApp', resolution: '1280x720', fps: 30, maxBytes: 16 * 1024 ** 2 },
  qhd: { name: '1440p master', resolution: '2560x1440', fps: 60 },
  uhd: { name: '4K master', resolution: '3840x2160', fps: 60 },
  square: { name: 'Square post', resolution: '1080x1080', fps: 30, vertical: true },
  portrait: { name: 'Portrait post', resolution: '1080x1350', fps: 30, vertical: true },
});
export const DEFAULT_EXPORT_FORMATS = Object.freeze(['landscape', 'vertical', 'whatsapp']);

function bounded(value, fallback, min, max, name) {
  const n = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new StudioError('INVALID_OPTION', `${name}: use a number between ${min} and ${max}.`);
  }
  return n;
}
function oneOf(value, fallback, allowed, name) {
  const v = value === undefined || value === '' ? fallback : value;
  if (!allowed.includes(v)) throw new StudioError('INVALID_OPTION', `${name}: choose ${allowed.join(', ')}.`);
  return v;
}
function normalizeMarkers(rows = []) {
  if (!Array.isArray(rows) || rows.length > 100) throw new StudioError('INVALID_OPTION', 'At most 100 markers.');
  return rows.map(m => ({
    time: bounded(m?.time, 0, 0, LIMITS.editSeconds, 'Marker time'),
    label: text(m?.label, 60),
    color: ['yellow', 'red', 'green', 'blue'].includes(m?.color) ? m.color : 'yellow',
  })).sort((a, b) => a.time - b.time);
}
function flag(value, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new StudioError('INVALID_OPTION', `${name}: true or false.`);
  return value;
}
const text = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);

export function normalizeOptions(value = {}) {
  let captions;
  try { captions = normalizeCaptions(value.captions); } catch (e) { throw new StudioError('INVALID_CAPTIONS', e.message); }
  const style = value.style ?? 'flight';
  if (!['action', 'flight'].includes(style)) throw new StudioError('INVALID_STYLE', 'Choose action or flight.');
  const masterFormat = value.masterFormat ?? 'landscape';
  if (!['landscape', 'qhd', 'uhd'].includes(masterFormat)) throw new StudioError('INVALID_EXPORT', 'Choose 1080p, 1440p or 4K.');
  for (const key of ['exportVertical', 'exportShare', 'exportSquare', 'exportPortrait']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new StudioError('INVALID_EXPORT', 'Invalid export choice.');
  }
  return {
    ...normalizeFinish(value),
    captions, captionOffset: bounded(value.captionOffset, 0, -30, 30, 'Caption offset'),
    captionStyle: oneOf(value.captionStyle, 'box', ['box', 'bold', 'minimal'], 'Caption style'),
    captionPosition: oneOf(value.captionPosition, 'low', ['low', 'middle', 'high'], 'Caption position'),
    captionAnimation: oneOf(value.captionAnimation, 'none', ['none', 'karaoke', 'pop', 'highlight', 'words'], 'Caption animation'),
    captionCase: oneOf(value.captionCase, 'normal', ['normal', 'upper'], 'Caption case'),
    markers: normalizeMarkers(value.markers),
    texts: (() => { try { return normalizeTexts(value.texts); } catch (e) { throw new StudioError('INVALID_TEXT', e.message); } })(),
    overlays: (() => { try { return normalizeOverlays(value.overlays); } catch (e) { throw new StudioError('INVALID_OVERLAY', e.message); } })(),
    sections: (() => { try { return normalizeSections(value.sections); } catch (e) { throw new StudioError('INVALID_SECTION', e.message); } })(),
    voiceEnhance: oneOf(value.voiceEnhance, 'off', ['off', 'light', 'strong'], 'Voice enhance'),
    segmentedRender: oneOf(value.segmentedRender, 'auto', ['auto', 'on', 'off'], 'Segmented render'),
    loudnessTarget: value.loudnessTarget === null || value.loudnessTarget === 'off' ? null : bounded(value.loudnessTarget, -14, -24, -9, 'Loudness target (LUFS)'),
    template: text(value.template, 40),
    musicTrimStart: bounded(value.musicTrimStart, 0, 0, 600, 'Music starts at'),
    brief: text(value.brief, 2000),
    masterFormat, exportVertical: value.exportVertical ?? true, exportShare: value.exportShare ?? true,
    exportSquare: value.exportSquare ?? false, exportPortrait: value.exportPortrait ?? false,
    title: text(value.title, 100),
    label: text(value.label ?? 'PRE-ALPHA FOOTAGE', 70),
    endTitle: text(value.endTitle ?? 'IN DEVELOPMENT', 100),
    style,
    duration: bounded(value.duration, 30, 5, LIMITS.editSeconds, 'Duration'),
    trimStart: bounded(value.trimStart, 0, 0, 600, 'Skip start'),
    trimEnd: bounded(value.trimEnd, 0, 0, 600, 'Skip end'),
    finaleSeconds: bounded(value.finaleSeconds, 0, 0, LIMITS.editSeconds, 'Continuous finale'),
    gameGain: bounded(value.gameGain, 1, 0, 2, 'Game audio'),
    musicGain: bounded(value.musicGain, 0.24, 0, 1, 'Music'),
    music: text(value.music, 1000),
    narration: text(value.narration, 1000),
    narrationStart: bounded(value.narrationStart, 0, 0, LIMITS.editSeconds, 'Voice-over start on timeline'),
    narrationTrimStart: bounded(value.narrationTrimStart, 0, 0, LIMITS.sourceSeconds, 'Voice-over source trim'),
    narrationGain: bounded(value.narrationGain, 1, 0, 2, 'Voice-over volume'),
    logo: text(value.logo, 1000),
    brand: text(value.brand, 40).toLowerCase().replace(/[^a-z0-9-]/g, ''),
    allowJumpCuts: flag(value.allowJumpCuts, false, 'Allow jump cuts'),
    autoCaptions: flag(value.autoCaptions, false, 'Captions follow transcript'),
    lut: text(value.lut, 1000), lutStrength: bounded(value.lutStrength, 1, 0, 1, 'LUT strength'),
    progressBar: oneOf(value.progressBar, 'off', ['off', 'bottom', 'top'], 'Progress bar'),
    sfx: (() => { try { return normalizeSfx(value.sfx ?? []); } catch (e) { throw new StudioError('INVALID_SFX', e.message); } })(),
    audioRepair: (() => { try { return normalizeAudioRepair(value.audioRepair); } catch (e) { throw new StudioError('INVALID_AUDIO', e.message); } })(),
  };
}

export function validateOverlaySources(overlays = [], sources) {
  overlays.forEach((o, i) => {
    if (!sources[o.sourceIndex] || o.end > sources[o.sourceIndex].duration + 0.05) throw new StudioError('INVALID_OVERLAY', `Overlay ${i + 1} points outside its source.`);
  });
}
export function validateCaptionSources(captions, sources) {
  for (const cue of captions) if (!sources[cue.sourceIndex] || cue.end > sources[cue.sourceIndex].duration + 0.05) {
    throw new StudioError('INVALID_CAPTIONS', 'Caption points outside the selected source. Use the SRT of the original source file.');
  }
}

/** Only indices of already registered media are accepted, never arbitrary paths. */
export function validateClips(rows, sources) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > LIMITS.clips) {
    throw new StudioError('INVALID_PLAN', `An edit contains 1 to ${LIMITS.clips} clips.`);
  }
  let timeline = 0;
  const seenIds = new Set();
  const clips = [];
  rows.forEach((row, index) => {
    const sourceIndex = Number(row.sourceIndex);
    const source = Number.isInteger(sourceIndex) ? sources[sourceIndex] : null;
    const start = Number(row.start);
    const end = Number(row.end);
    if (!source || !Number.isFinite(start) || !Number.isFinite(end) || start < 0
      || end > source.duration + 0.001 || end - start < 0.5) {
      throw new StudioError('INVALID_CLIP', `Clip ${index + 1}: start/end fall outside the source or are too short.`);
    }
    const speed = bounded(row.speed, 1, 0.5, 2, 'Clip speed');
    const gain = bounded(row.gain, 1, 0, 2, 'Clip audio');
    const duration = (end - start) / speed;
    if (duration < 0.25) throw new StudioError('INVALID_CLIP', 'A clip must last at least 0.25 s after the speed change.');
    const audioShift = bounded(row.audioShift, 0, -2, 2, 'Audio shift (J/L cut)');
    const stabilize = bounded(row.stabilize, 0, 0, 1, 'Stabilise');
    const id = typeof row.id === 'string' && /^[a-z0-9]{1,24}$/.test(row.id) && !seenIds.has(row.id) ? row.id : newClipId();
    seenIds.add(id);
    const clip = {
      id, label: text(row.label, 60),
      ...normalizeTransform(row), ...normalizeTransition(index === 0 ? {} : row), ...normalizeColor(row),
      sourceIndex, source: source.file, sourceName: path.basename(source.file),
      start, end, duration, speed, gain, sourceDuration: end - start, hasAudio: Boolean(source.hasAudio), ...(audioShift && index ? { audioShift } : {}), ...(stabilize ? { stabilize } : {}),
      timelineStart: timeline, order: index + 1,
    };
    clip.overlap = index === 0 ? 0 : overlapOf(clips[index - 1], clip);
    clip.timelineStart -= clip.overlap;
    timeline += duration - clip.overlap;
    clips.push(clip);
    return clip;
  });
  if (timeline > LIMITS.editSeconds + 0.05) throw new StudioError('INVALID_PLAN', `An edit may be at most ${LIMITS.editSeconds / 60} minutes long.`);
  for (let i = 0; i < clips.length; i++) {
    for (let j = i + 1; j < clips.length; j++) {
      const a = clips[i], b = clips[j];
      if (a.sourceIndex === b.sourceIndex && Math.min(a.end, b.end) - Math.max(a.start, b.start) > 0.001) {
        throw new StudioError('OVERLAPPING_CLIPS', `Clips ${i + 1} and ${j + 1} use the same footage. Adjust the time ranges.`);
      }
    }
  }
  return { schemaVersion: 2, clips, clipCount: clips.length, actualDuration: Number(timeline.toFixed(3)) };
}

function allowedIntervals(source, opts) {
  let intervals = [[opts.trimStart, source.duration - opts.trimEnd]].filter(([a, b]) => b - a >= 0.5);
  for (const black of source.black ?? []) {
    intervals = intervals.flatMap(([a, b]) => {
      if (black.end <= a || black.start >= b) return [[a, b]];
      return [[a, Math.max(a, black.start)], [Math.min(b, black.end), b]].filter(([x, y]) => y - x >= 0.5);
    });
  }
  return intervals;
}

/** Long, chronological windows; no invented frames and no repeated time ranges. */
export function proposeEdit(input, options) {
  // Still images are B-roll to place by hand: the proposal treats them as unavailable.
  const analysis = { ...input, sources: input.sources.map(s => s.still ? { ...s, black: [{ start: 0, end: s.duration, duration: s.duration }] } : s) };
  const opts = normalizeOptions(options);
  if (opts.finaleSeconds > opts.duration) throw new StudioError('INVALID_FINALE', 'The finale cannot be longer than the target duration.');
  if (opts.finaleSeconds > 0) return proposeWithFinale(analysis, opts);
  let rows;
  if (opts.style === 'flight') {
    const intervals = analysis.sources.flatMap((source, sourceIndex) =>
      allowedIntervals(source, opts).map(([a, b]) => ({ sourceIndex, a, b })));
    const available = intervals.reduce((sum, x) => sum + x.b - x.a, 0);
    if (available < 0.5) throw new StudioError('NO_CANDIDATES', 'No usable footage remains after trimming.');
    const target = Math.min(opts.duration, available);
    rows = [];
    // Allocate time proportionally, then spread long shots across each flight.
    for (const interval of intervals) {
      const length = interval.b - interval.a;
      const allotment = target * length / available;
      if (allotment < 0.5) continue;
      const count = Math.max(1, Math.ceil(allotment / 18));
      const shot = allotment / count;
      const gap = count > 1 ? (length - allotment) / (count - 1) : 0;
      for (let i = 0; i < count; i++) {
        const start = interval.a + i * (shot + gap);
        rows.push({ sourceIndex: interval.sourceIndex, start, end: Math.min(interval.b, start + shot) });
      }
    }
  } else {
    const adjusted = { ...analysis, sources: analysis.sources.map(source => ({
      ...source,
      black: [...(source.black ?? []), { start: 0, end: opts.trimStart },
        { start: source.duration - opts.trimEnd, end: source.duration }],
    })) };
    const plan = buildTrailerPlan(adjusted, { duration: opts.duration, style: 'action' });
    rows = plan.clips.slice(0, LIMITS.clips).filter(clip => clip.start >= opts.trimStart
      && clip.end <= analysis.sources.find(s => s.file === clip.source).duration - opts.trimEnd)
      .map(clip => ({ sourceIndex: analysis.sources.findIndex(s => s.file === clip.source), start: clip.start, end: clip.end }));
  }
  const plan = validateClips(rows, analysis.sources);
  plan.style = opts.style;
  plan.warnings = plan.actualDuration < opts.duration - 1
    ? [`${plan.actualDuration.toFixed(1)} s of unique footage selected; sources are not repeated to fill the duration.`] : [];
  return plan;
}

/** Reserve the end of the last usable source as one continuous shot. */
function proposeWithFinale(analysis, opts) {
  const intervals = analysis.sources.flatMap((source, sourceIndex) =>
    allowedIntervals(source, opts).map(([start, end]) => ({ sourceIndex, start, end })));
  const last = intervals.at(-1);
  if (!last || last.end - last.start < opts.finaleSeconds || opts.finaleSeconds < 0.5) {
    throw new StudioError('INVALID_FINALE', 'No continuous ending of this length is available. Shorten the finale or adjust the trim.');
  }
  const finalShot = { sourceIndex: last.sourceIndex, start: last.end - opts.finaleSeconds, end: last.end };
  const remaining = opts.duration - opts.finaleSeconds;
  let rows = [];
  if (remaining >= 0.5) {
    const sources = analysis.sources.slice(0, last.sourceIndex + 1).map((source, index) => ({
      ...source,
      black: [...(source.black ?? []), ...(index === last.sourceIndex ? [{ start: finalShot.start, end: source.duration }] : [])],
    }));
    try {
      const prefix = proposeEdit({ sources }, { ...opts, duration: Math.max(5, remaining), finaleSeconds: 0 });
      let budget = remaining;
      for (const clip of prefix.clips) {
        const end = clip.sourceIndex === last.sourceIndex ? Math.min(clip.end, finalShot.start) : clip.end;
        const duration = Math.min(budget, end - clip.start);
        if (duration < 0.5) break;
        rows.push({ sourceIndex: clip.sourceIndex, start: clip.start, end: clip.start + duration });
        budget -= duration;
      }
    } catch (e) {
      if (!['NO_CANDIDATES', 'INVALID_PLAN'].includes(e.code)) throw e;
    }
  }
  const plan = validateClips([...rows, finalShot], analysis.sources);
  plan.style = opts.style;
  plan.finaleSeconds = opts.finaleSeconds;
  plan.warnings = plan.actualDuration < opts.duration - 0.1
    ? ['Less unique footage available; the continuous finale is fully preserved.'] : [];
  return plan;
}
