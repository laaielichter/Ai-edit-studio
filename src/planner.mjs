import path from 'node:path';
import { StudioError } from './paths.mjs';

export const STYLE_PRESETS = Object.freeze({
  action: { shot: 2.6, minGap: 7, weights: { motion: 0.38, audio: 0.34, scene: 0.18, quality: 0.10 } },
  cinematic: { shot: 5.5, minGap: 12, weights: { motion: 0.22, audio: 0.18, scene: 0.35, quality: 0.25 } },
  gameplay: { shot: 4.2, minGap: 9, weights: { motion: 0.32, audio: 0.28, scene: 0.18, quality: 0.22 } },
  showcase: { shot: 6.0, minGap: 14, weights: { motion: 0.18, audio: 0.12, scene: 0.35, quality: 0.35 } },
  'air-combat': { shot: 3.8, minGap: 9, weights: { motion: 0.40, audio: 0.27, scene: 0.20, quality: 0.13 } },
});

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = clamp(fraction, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const mix = position - lower;
  return sorted[lower] * (1 - mix) + sorted[upper] * mix;
}

function robustNormalizer(values) {
  const clean = values.filter(Number.isFinite);
  const low = percentile(clean, 0.10);
  const high = percentile(clean, 0.90);
  const span = Math.max(1e-9, high - low);
  return (value) => clamp((Number(value) - low) / span, 0, 1);
}

function pointsInRange(points, start, end) {
  return (points ?? []).filter((point) => point.time >= start && point.time <= end);
}

function mean(values, fallback = 0) {
  if (!values.length) return fallback;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function overlap(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function blackFraction(intervals, start, end) {
  const duration = Math.max(0.001, end - start);
  return (intervals ?? []).reduce(
    (sum, interval) => sum + overlap(start, end, interval.start, interval.end),
    0,
  ) / duration;
}

function rawCandidate(source, start, duration, sceneAnchor) {
  const end = Math.min(source.duration, start + duration);
  const actualDuration = end - start;
  const motion = pointsInRange(source.motion, start, end).map((point) => point.value);
  const audio = pointsInRange(source.audio, start, end).map((point) => point.value);
  const audioMean = mean(audio, -90);
  const audioPeak = audio.length ? Math.max(...audio) : -90;
  return {
    source: source.file,
    sourceName: path.basename(source.file),
    sourceDuration: source.duration,
    start,
    end,
    duration: actualDuration,
    hasAudio: Boolean(source.hasAudio),
    blackFraction: blackFraction(source.black, start, end),
    raw: {
      motion: mean(motion),
      audio: audioPeak + Math.max(0, audioPeak - audioMean) * 0.7,
      scene: sceneAnchor ? 1 : 0.15,
      quality: Math.log2(Math.max(1, source.video.width * source.video.height)),
    },
  };
}

function candidateWindows(source, preset) {
  const candidates = [];
  const base = preset.shot;
  const durations = [base * 0.65, base, base * 1.35].map((value) => clamp(value, 1.25, 8));
  const centers = [];
  for (const time of source.scenes ?? []) centers.push({ time, scene: true });
  if (
    source.duration >= 1.25
    && !centers.some((center) => Math.abs(center.time - source.duration / 2) < 0.1)
  ) {
    centers.push({ time: source.duration / 2, scene: false });
  }
  const step = Math.max(1.5, base * 0.8);
  for (let time = base * 0.65; time < source.duration; time += step) centers.push({ time, scene: false });

  const seen = new Set();
  for (let index = 0; index < centers.length; index += 1) {
    const center = centers[index];
    const duration = durations[index % durations.length];
    if (source.duration < 1.25) continue;
    const usableDuration = Math.min(duration, source.duration);
    const start = clamp(center.time - usableDuration * 0.65, 0, source.duration - usableDuration);
    const key = `${start.toFixed(2)}:${usableDuration.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const candidate = rawCandidate(source, start, usableDuration, center.scene);
    if (candidate.duration >= 1.2 && candidate.blackFraction <= 0.05) candidates.push(candidate);
  }
  return candidates;
}

function scoreCandidates(candidates, preset) {
  const normalizers = {
    motion: robustNormalizer(candidates.map((candidate) => candidate.raw.motion)),
    audio: robustNormalizer(candidates.map((candidate) => candidate.raw.audio)),
    scene: robustNormalizer(candidates.map((candidate) => candidate.raw.scene)),
    quality: robustNormalizer(candidates.map((candidate) => candidate.raw.quality)),
  };
  return candidates.map((candidate) => {
    const features = Object.fromEntries(
      Object.entries(candidate.raw).map(([key, value]) => [key, normalizers[key](value)]),
    );
    const score = Object.entries(preset.weights).reduce(
      (sum, [key, weight]) => sum + features[key] * weight,
      0,
    ) - candidate.blackFraction * 2;
    return { ...candidate, features, score };
  });
}

function conflicts(candidate, selected, minGap) {
  return selected.some((clip) => {
    if (clip.source !== candidate.source) return false;
    const shared = overlap(clip.start, clip.end, candidate.start, candidate.end);
    const gap = shared > 0
      ? 0
      : Math.max(clip.start, candidate.start) - Math.min(clip.end, candidate.end);
    return shared > 0 || gap < minGap;
  });
}

function arrangeTrailer(selected) {
  if (selected.length <= 2) return [...selected];
  const ranked = [...selected].sort((a, b) => b.score - a.score || a.start - b.start);
  const hook = ranked.shift();
  ranked.sort((a, b) => a.score - b.score || a.sourceName.localeCompare(b.sourceName));
  return [hook, ...ranked];
}

export function buildTrailerPlan(analysis, {
  duration = 60,
  style = 'action',
  seed = 42,
  title = '',
} = {}) {
  const targetDuration = clamp(Number(duration) || 60, 5, 300);
  const preset = STYLE_PRESETS[style];
  if (!preset) throw new StudioError('INVALID_STYLE', `Unknown trailer style: ${style}.`);
  if (!analysis?.sources?.length) throw new StudioError('NO_SOURCES', 'There are no analyzed video sources.');

  const raw = analysis.sources.flatMap((source) => candidateWindows(source, preset));
  if (!raw.length) throw new StudioError('NO_CANDIDATES', 'No usable clips found.');
  const scored = scoreCandidates(raw, preset).sort(
    (a, b) => b.score - a.score || a.source.localeCompare(b.source) || a.start - b.start,
  );

  const selected = [];
  const perSource = new Map();
  let total = 0;
  const sourceLimit = analysis.sources.length > 1 ? targetDuration * 0.45 : Number.POSITIVE_INFINITY;

  for (const candidate of scored) {
    if (total >= targetDuration - 0.25) break;
    if (conflicts(candidate, selected, preset.minGap)) continue;
    if ((perSource.get(candidate.source) ?? 0) + candidate.duration > sourceLimit) continue;
    const remaining = targetDuration - total;
    const durationToUse = Math.min(candidate.duration, remaining);
    if (durationToUse < 1.0) break;
    const clip = { ...candidate, duration: durationToUse, end: candidate.start + durationToUse };
    selected.push(clip);
    total += durationToUse;
    perSource.set(candidate.source, (perSource.get(candidate.source) ?? 0) + durationToUse);
  }

  if (total < targetDuration - 1) {
    for (const candidate of scored) {
      if (total >= targetDuration - 0.25) break;
      if (conflicts(candidate, selected, 0)) continue;
      const remaining = targetDuration - total;
      const durationToUse = Math.min(candidate.duration, remaining);
      if (durationToUse < 1.0) break;
      selected.push({ ...candidate, duration: durationToUse, end: candidate.start + durationToUse });
      total += durationToUse;
    }
  }

  const ordered = arrangeTrailer(selected);
  let timeline = 0;
  const clips = ordered.map((clip, index) => {
    const result = {
      order: index + 1,
      source: clip.source,
      sourceName: clip.sourceName,
      start: Number(clip.start.toFixed(3)),
      end: Number(clip.end.toFixed(3)),
      duration: Number(clip.duration.toFixed(3)),
      timelineStart: Number(timeline.toFixed(3)),
      score: Number(clip.score.toFixed(4)),
      features: Object.fromEntries(
        Object.entries(clip.features).map(([key, value]) => [key, Number(value.toFixed(4))]),
      ),
      hasAudio: clip.hasAudio,
    };
    timeline += clip.duration;
    return result;
  });

  const warnings = [];
  if (timeline < targetDuration - 1) {
    warnings.push(`There was ${timeline.toFixed(1)} s of unique usable footage for a target of ${targetDuration.toFixed(1)} s; nothing was duplicated.`);
  }
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    seed,
    style,
    title,
    targetDuration,
    actualDuration: Number(timeline.toFixed(3)),
    clipCount: clips.length,
    clips,
    warnings,
  };
}
