// Quality control of a FINISHED render: loudness (EBU R128), true peak, black and frozen picture,
// long silences, duration and file size. Measures the real file, not the plan.
import fs from 'node:fs/promises';
import { findFfmpegTools, probeMedia } from './ffmpeg.mjs';
import { runProcess } from './process.mjs';

export function parseQcLog(log) {
  const at = log.lastIndexOf('Summary:');
  const summary = at >= 0 ? log.slice(at) : '';
  const intervals = (start, end) => {
    const out = [], starts = [...log.matchAll(start)].map(m => Number(m[1])), ends = [...log.matchAll(end)].map(m => Number(m[1]));
    starts.forEach((s, i) => out.push({ start: s, end: ends[i] ?? null }));
    return out;
  };
  return {
    loudness: (() => { const m = summary.match(/I:\s+(-?[\d.]+) LUFS/); return m ? Number(m[1]) : null; })(),
    range: (() => { const m = summary.match(/LRA:\s+(-?[\d.]+) LU/); return m ? Number(m[1]) : null; })(),
    truePeak: (() => { const m = summary.match(/Peak:\s+(-?[\d.inf]+) dBFS/); return m ? (m[1].includes('inf') ? -Infinity : Number(m[1])) : null; })(),
    black: [...log.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)].map(m => ({ start: Number(m[1]), end: Number(m[2]) })),
    freeze: intervals(/freeze_start:\s*([\d.]+)/g, /freeze_end:\s*([\d.]+)/g),
    silence: intervals(/silence_start:\s*(-?[\d.]+)/g, /silence_end:\s*([\d.]+)/g),
  };
}

/** Checks with severities and concrete fixes. */
export function judgeQc(m, { duration, expectedDuration, bytes, maxBytes, loudnessTarget = -14, fadeIn = 0, fadeOut = 0, hasStills = false } = {}) {
  const issues = [];
  const add = (severity, code, message, fix) => issues.push({ severity, code, message, ...(fix ? { fix } : {}) });
  if (Number.isFinite(m.loudness) && Number.isFinite(loudnessTarget) && Math.abs(m.loudness - loudnessTarget) > 2) {
    add('warning', 'LOUDNESS', `Loudness is ${m.loudness.toFixed(1)} LUFS; target ${loudnessTarget} LUFS.`, { operations: [{ op: 'set_options', options: { loudnessTarget } }], note: 'Re-render after setting the target.' });
  }
  if (Number.isFinite(m.truePeak) && m.truePeak > -1) add('warning', 'TRUE_PEAK', `Peak ${m.truePeak.toFixed(1)} dBFS: risk of clipping after platform encoding (aim ≤ −1).`);
  const inner = (s, e) => e == null || (s > fadeIn + 0.3 && e < duration - fadeOut - 0.3);
  for (const b of m.black.filter(b => b.end - b.start >= 0.5 && inner(b.start, b.end))) add('warning', 'BLACK', `Black picture ${b.start.toFixed(1)}–${b.end.toFixed(1)} s.`);
  if (!hasStills) for (const f of m.freeze.filter(f => (f.end ?? duration) - f.start >= 2)) add('tip', 'FROZEN', `Picture does not move ${f.start.toFixed(1)}–${(f.end ?? duration).toFixed(1)} s (intended?).`);
  for (const s of m.silence.filter(s => (s.end ?? duration) - s.start >= 2 && s.start > 0.3)) add('tip', 'SILENCE', `Silence ${s.start.toFixed(1)}–${(s.end ?? duration).toFixed(1)} s.`);
  if (Number.isFinite(expectedDuration) && Math.abs(duration - expectedDuration) > 0.25) add('error', 'DURATION', `Render lasts ${duration.toFixed(2)} s; the edit is ${expectedDuration.toFixed(2)} s.`);
  if (maxBytes && bytes > maxBytes) add('error', 'TOO_LARGE', `File is ${(bytes / 1024 ** 2).toFixed(1)} MiB; limit ${(maxBytes / 1024 ** 2).toFixed(0)} MiB.`);
  const weight = { error: 30, warning: 10, tip: 2 };
  const score = Math.max(0, 100 - issues.reduce((s, i) => s + weight[i.severity], 0));
  return { score, passed: !issues.some(i => i.severity === 'error'), issues };
}

export async function qcFile(file, options = {}, tools = findFfmpegTools()) {
  const info = await probeMedia(file, tools);
  const stat = await fs.stat(file);
  const result = await runProcess(tools.ffmpeg, ['-hide_banner', '-nostats', '-protocol_whitelist', 'file,pipe', '-i', file,
    ...(info.audio ? ['-af', 'ebur128=peak=true,silencedetect=noise=-50dB:d=2'] : []),
    '-vf', 'fps=10,scale=320:-2,blackdetect=d=0.5:pic_th=0.97:pix_th=0.10,freezedetect=n=0.002:d=2', '-f', 'null', '-'],
  { timeoutMs: 60 * 60_000, maxOutputBytes: 64 * 1024 * 1024 });
  const measured = parseQcLog(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  const verdict = judgeQc(measured, { ...options, duration: info.duration, bytes: stat.size });
  return {
    file, duration: info.duration, width: info.video?.width, height: info.video?.height, fps: info.video?.fps, bytes: stat.size,
    loudness: measured.loudness, loudnessRange: measured.range, truePeak: measured.truePeak,
    blackSegments: measured.black.length, frozenSegments: measured.freeze.length, silences: measured.silence.length, ...verdict,
    note: 'Measured on the finished file. Platforms normalise to about −14 LUFS.',
  };
}
