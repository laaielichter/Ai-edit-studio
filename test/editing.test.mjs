import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOptions, validateClips, proposeEdit, EXPORT_PRESETS, DEFAULT_EXPORT_FORMATS } from '../src/editing.mjs';
const source = (file = 'flight.mp4', duration = 80) => ({ file, duration, size: 100, video: { width: 1920, height: 1080 }, hasAudio: true, black: [], motion: [], audio: [], scenes: [] });

test('flight edit is chronological, long-shot and does not repeat source ranges', () => {
  const plan = proposeEdit({ sources: [source()] }, { style: 'flight', duration: 30, trimStart: 2, trimEnd: 4 });
  assert.equal(plan.clips.length, 2); assert.equal(plan.actualDuration, 30);
  assert.equal(plan.clips[0].start, 2); assert.equal(plan.clips[1].end, 76);
  assert.ok(plan.clips[0].end <= plan.clips[1].start); assert.ok(plan.clips.every(c => c.duration >= 10));
});
test('short footage is not padded with duplicated shots', () => {
  const plan = proposeEdit({ sources: [source('short.mp4', 7)] }, { duration: 30 });
  assert.equal(plan.actualDuration, 7); assert.equal(plan.clips.length, 1); assert.equal(plan.warnings.length, 1);
});
test('flight edit avoids detected black intervals', () => {
  const s = source(); s.black = [{ start: 20, end: 30 }];
  const plan = proposeEdit({ sources: [s] }, { duration: 60 });
  for (const c of plan.clips) assert.ok(c.end <= 20 || c.start >= 30);
});
test('manual edits reject arbitrary sources, invalid bounds and overlapping footage', () => {
  assert.throws(() => validateClips([{ sourceIndex: 4, start: 0, end: 1 }], [source()]));
  assert.throws(() => validateClips([{ sourceIndex: 0, start: -1, end: 1 }], [source()]));
  assert.throws(() => validateClips([{ sourceIndex: 0, start: 0, end: 100 }], [source()]));
  assert.throws(() => validateClips([{ sourceIndex: 0, start: 0, end: 10 }, { sourceIndex: 0, start: 9, end: 15 }], [source()]), /same footage/);
  assert.throws(() => validateClips([], [source()]));
});
test('manual source replacement derives path and audio from registered source', () => {
  const sources = [source(), { ...source('silent.mp4'), hasAudio: false }];
  const plan = validateClips([{ sourceIndex: 1, source: 'private-key', start: 4, end: 8 }], sources);
  assert.equal(plan.clips[0].source, 'silent.mp4'); assert.equal(plan.clips[0].hasAudio, false);
});
test('audio gains stay zero when muted and reject invalid values', () => {
  assert.equal(normalizeOptions({ gameGain: 0, musicGain: 0 }).gameGain, 0);
  assert.throws(() => normalizeOptions({ musicGain: 'NaN' }));
  assert.throws(() => normalizeOptions({ gameGain: 99 }));
  assert.throws(() => normalizeOptions({ style: 'unknown' }));
});
test('action proposal differs from long flight cut and stays within trims', () => {
  const plan = proposeEdit({ sources: [source()] }, { style: 'action', duration: 30, trimStart: 2, trimEnd: 4 });
  assert.ok(plan.clips.length > 3); assert.ok(plan.clips.every(c => c.start >= 2 && c.end <= 76));
});
test('public beta keeps the three default output formats', () => {
  assert.deepEqual(DEFAULT_EXPORT_FORMATS, ['landscape', 'vertical', 'whatsapp']);
  assert.equal(Object.keys(EXPORT_PRESETS).length, 16);
  assert.equal(EXPORT_PRESETS.vertical.resolution, '1080x1920');
  assert.equal(EXPORT_PRESETS.whatsapp.maxBytes, 16 * 1024 ** 2);
});
