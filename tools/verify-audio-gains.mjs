import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { renderTrailer } from '../src/render.mjs';
import { validateClips } from '../src/editing.mjs';
import { probeMedia, findFfmpegTools } from '../src/ffmpeg.mjs';
import { DATA_ROOT, safeResolveWithin } from '../src/paths.mjs';
import { runProcess } from '../src/process.mjs';
const [source, output] = process.argv.slice(2);
safeResolveWithin(DATA_ROOT, path.relative(DATA_ROOT, path.resolve(output)));
await fs.mkdir(output, { recursive: false });
const tools = findFfmpegTools(), info = await probeMedia(source, tools), measurements = [];
for (const gain of [1, 0.5, 0]) {
  const plan = validateClips([{ sourceIndex: 0, start: 0, end: 1.5, gain }], [{ ...info, file: source, hasAudio: true }]);
  const result = await renderTrailer(plan, { jobRoot: path.join(output, `gain-${gain}`), preview: true, software: true, fadeIn: 0, fadeOut: 0, tools });
  const check = await runProcess(tools.ffmpeg, ['-hide_banner', '-nostdin', '-i', result.output, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { timeoutMs: 60000 });
  const match = (check.stderr + check.stdout).match(/mean_volume:\s*([\d.-]+) dB/); assert.ok(match);
  measurements.push({ gain, meanDb: Number(match[1]), encoder: result.encoder });
}
assert.ok(Math.abs((measurements[1].meanDb - measurements[0].meanDb) + 6.02) < 0.6);
assert.ok(measurements[2].meanDb <= -90);
assert.ok(measurements.every(m => m.encoder === 'libx264'));
const voicePlan = validateClips([{ sourceIndex: 0, start: 0, end: 1.5 }], [{ ...info, file: source, hasAudio: true }]);
const voice = await renderTrailer(voicePlan, { jobRoot: path.join(output, 'voice-timing'), preview: true, software: true, gameGain: 0,
  narration: path.join(path.dirname(source), 'music.wav'), narrationStart: 0.5, narrationTrimStart: 0.2, fadeOut: 0, tools });
const windows = [];
for (const start of [0.1, 0.8, 1.4]) {
  const r = await runProcess(tools.ffmpeg, ['-hide_banner', '-nostdin', '-ss', String(start), '-t', '0.08', '-i', voice.output, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { timeoutMs: 60000 });
  windows.push(Number((r.stderr + r.stdout).match(/mean_volume:\s*([\d.-]+) dB/)[1]));
}
assert.ok(windows[0] <= -80 && windows[1] > -30 && windows[2] <= -80, JSON.stringify(windows));
const report = { passed: true, measurements, checks: ['per-clip half gain retains approximately -6 dB AFTER normalisation', 'mute stays silent', 'software fallback produces decodable video/audio'] };
report.voiceWindowsMeanDb = windows; report.checks.push('trimmed voice-over starts after 0.5s, is audible, ends without looping');
await fs.writeFile(path.join(output, 'audio-verification.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
