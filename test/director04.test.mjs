import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOperations, applyOperation, layout, totalDuration, diffEdits, beatSync, clipAt, unusedRanges, coreClips } from '../public/edit-ops.js';
import { reviewEdit, hookScore, highlights, describeTimeline } from '../public/insights.js';
import { analyzeBeats, timelineBeats } from '../src/beats.mjs';
import { agentTools, validateArguments, callAgentTool } from '../src/agent-tools.mjs';
import { normalizeOptions, validateClips } from '../src/editing.mjs';
import { captionDrawStyle, buildFilter } from '../src/render.mjs';
import { normalizeFinish } from '../src/finishing.mjs';
import { TEMPLATES, templateOptions } from '../src/templates.mjs';

const sources = [{ duration: 60 }, { duration: 30 }];
const base = () => ({
  clips: [
    { id: 'a', sourceIndex: 0, start: 0, end: 4, speed: 1, gain: 1 },
    { id: 'b', sourceIndex: 0, start: 10, end: 14, speed: 1, gain: 1 },
    { id: 'c', sourceIndex: 1, start: 5, end: 9, speed: 2, gain: 1 },
  ], options: { duration: 30 },
});
const run = (ops, state = base(), ctx = {}) => applyOperations(state, ops, { sources, ...ctx });

test('split at a timeline time keeps source continuity and gives the new half a fresh id', () => {
  const { clips } = run([{ op: 'split', at: 6 }]);
  assert.equal(clips.length, 4);
  assert.deepEqual([clips[1].start, clips[1].end, clips[2].start, clips[2].end], [10, 12, 12, 14]);
  assert.equal(clips[1].id, 'b'); assert.notEqual(clips[2].id, 'b');
  assert.throws(() => run([{ op: 'split', at: 3.8 }]), /0.5/);
});
test('speed-aware split and clipAt map timeline to source time', () => {
  const hit = clipAt(base().clips, 9); // clip c starts at 8 on the timeline, speed 2
  assert.equal(hit.index, 2); assert.equal(hit.sourceTime, 7);
  const { clips } = run([{ op: 'split', at: 9 }]);
  assert.equal(clips[2].end, 7); assert.equal(clips[3].start, 7);
});
test('ripple delete, delete_range across clips, move, swap and trim_to', () => {
  assert.deepEqual(run([{ op: 'delete', clip: 'b' }]).clips.map(c => c.id), ['a', 'c']);
  assert.throws(() => run([{ op: 'delete', clips: ['a', 'b', 'c'] }]), /at least one/);
  const ranged = run([{ op: 'delete_range', from: 3, to: 5 }]).clips;
  assert.equal(ranged[0].end, 3); assert.equal(ranged[1].start, 11); assert.equal(totalDuration(ranged), 8);
  assert.deepEqual(run([{ op: 'move', clip: 'a', to: 2 }]).clips.map(c => c.id), ['b', 'c', 'a']);
  assert.deepEqual(run([{ op: 'swap', a: 0, b: 'c' }]).clips.map(c => c.id), ['c', 'b', 'a']);
  assert.equal(run([{ op: 'trim_to', at: 5, side: 'start' }]).clips[1].start, 11);
  assert.equal(run([{ op: 'trim_to', at: 5, side: 'end' }]).clips[1].end, 11);
});
test('trim, slip and insert respect source bounds and never reuse footage', () => {
  assert.equal(run([{ op: 'trim', clip: 'a', endDelta: 2 }]).clips[0].end, 6);
  assert.throws(() => run([{ op: 'trim', clip: 'a', end: 11 }]), /same footage/);
  assert.throws(() => run([{ op: 'trim', clip: 'c', end: 31 }]), /outside/);
  assert.equal(run([{ op: 'slip', clip: 'b', by: 2 }]).clips[1].start, 12);
  const inserted = run([{ op: 'insert', sourceIndex: 0, start: 20, end: 22, at: 6 }]).clips;
  assert.deepEqual(inserted.map(c => [c.sourceIndex, c.start, c.end]).slice(1, 4), [[0, 10, 12], [0, 20, 22], [0, 12, 14]]);
  assert.throws(() => run([{ op: 'insert', sourceIndex: 0, start: 1, end: 3 }]), /same footage/);
  assert.deepEqual(unusedRanges(base().clips, 0, 60), [[4, 10], [14, 60]]);
});
test('set requires an explicit target and validates values; batches are atomic', () => {
  assert.throws(() => run([{ op: 'set', gain: 0 }]), /clip/);
  assert.equal(run([{ op: 'set', clip: 'all', gain: 0.5 }]).clips.every(c => c.gain === 0.5), true);
  const zoomed = run([{ op: 'set', clip: 'a', zoom: 1.5 }]).clips[0];
  assert.equal(zoomed.framing, 'fill');
  assert.throws(() => run([{ op: 'set', clip: 'a', speed: 9 }]));
  const state = base();
  assert.throws(() => applyOperations(state, [{ op: 'delete', clip: 'a' }, { op: 'trim', clip: 'zz', end: 1 }], { sources }), /Operation 2/);
  assert.equal(state.clips.length, 3, 'input state is never mutated');
  assert.throws(() => run([{ op: 'explode' }]), /Unknown operation/);
});
test('markers and set_options live in options', () => {
  const s = run([{ op: 'add_marker', time: 5, label: 'drop', color: 'red' }, { op: 'add_marker', time: 2 }, { op: 'set_options', options: { title: 'X' } }]);
  assert.deepEqual(s.options.markers.map(m => m.time), [2, 5]); assert.equal(s.options.title, 'X');
  assert.equal(applyOperation(s, { op: 'remove_marker', index: 0 }, { sources }).options.markers.length, 1);
});
test('beat sync moves cut points onto beats within reach and keeps clips valid', () => {
  const beats = Array.from({ length: 40 }, (_, i) => i * 0.5 + 0.2);
  const { clips, moved } = beatSync(base().clips, beats, { sources, maxShift: 0.35 });
  assert.ok(moved >= 1);
  for (const r of layout(clips).slice(0, -1)) assert.ok(beats.some(b => Math.abs(b - r.timelineEnd) < 0.002), `cut ${r.timelineEnd}`);
  assert.throws(() => run([{ op: 'beat_sync' }]), /beat/);
  assert.ok(run([{ op: 'beat_sync' }], base(), { beats }).clips.length === 3);
});
test('diff reports added, removed, changed and real moves by id', () => {
  const before = base(), after = run([{ op: 'move', clip: 'c', to: 0 }, { op: 'delete', clip: 'a' }, { op: 'set', clip: 'b', gain: 0.2 }, { op: 'insert', sourceIndex: 1, start: 20, end: 22 }]);
  const d = diffEdits(before, after);
  assert.equal(d.removed.length, 1); assert.equal(d.added.length, 1); assert.deepEqual(d.changed.map(c => c.id), ['b']);
  assert.ok(d.moved.some(m => m.id === 'c')); assert.match(d.summary, /added/);
  assert.equal(diffEdits(before, base()).summary, 'No changes');
});

// ---------------------------------------------------------------- beats
test('beat tracker finds 120 BPM in a synthetic click track', () => {
  const rate = 22050, seconds = 12, samples = new Float32Array(rate * seconds);
  for (let b = 0.25; b < seconds; b += 0.5) for (let i = 0; i < 400; i++) samples[Math.floor(b * rate) + i] = Math.sin(i / 3) * Math.exp(-i / 80);
  const r = analyzeBeats(samples);
  assert.ok(Math.abs(r.bpm - 120) < 3, `bpm ${r.bpm}`);
  const offsets = r.beats.map(b => Math.abs(((b - 0.25) % 0.5 + 0.5) % 0.5));
  assert.ok(offsets.filter(o => Math.min(o, 0.5 - o) < 0.04).length / offsets.length > 0.8);
  assert.deepEqual(timelineBeats({ beats: [1, 2, 3], duration: 4 }, 1.5, 10).slice(0, 4), [0.5, 1.5, 3.5, 4.5]);
  assert.throws(() => analyzeBeats(new Float32Array(rate)), /3 seconds/);
});

// ---------------------------------------------------------------- insights
const analyzed = () => [{
  name: 'a.mp4', file: 'a.mp4', duration: 40, hasAudio: true, video: { width: 1920, height: 1080 },
  motion: Array.from({ length: 160 }, (_, i) => ({ time: i / 4, value: i / 4 > 20 && i / 4 < 26 ? 30 : 2 })),
  audio: Array.from({ length: 80 }, (_, i) => ({ time: i / 2, value: i / 2 > 20 && i / 2 < 26 ? -12 : -40 })),
  scenes: [21, 23], black: [{ start: 30, end: 31.5 }],
}];
test('review flags jump cuts, flash shots, black frames and a weak hook with applicable fixes', () => {
  const src = analyzed();
  const clips = validateClips([
    { id: 'x', sourceIndex: 0, start: 0, end: 4 }, { id: 'y', sourceIndex: 0, start: 4.3, end: 8 },
    { id: 'z', sourceIndex: 0, start: 9, end: 9.6 }, { id: 'w', sourceIndex: 0, start: 29.5, end: 33 }, { id: 'v', sourceIndex: 0, start: 21, end: 25 },
  ], src).clips;
  const review = reviewEdit({ clips, sources: src, options: { style: 'action', duration: 30 } });
  const codes = review.issues.map(i => i.code);
  for (const code of ['JUMP_CUT', 'SHORT_SHOT', 'BLACK_FRAMES', 'WEAK_HOOK', 'NO_MUSIC']) assert.ok(codes.includes(code), code);
  assert.ok(review.score < 80);
  const hook = review.issues.find(i => i.code === 'WEAK_HOOK');
  const fixed = applyOperations({ clips: coreClips(clips), options: {} }, hook.fix.operations, { sources: src });
  assert.equal(fixed.clips[0].id, 'v');
  assert.ok(hookScore(fixed.clips, src).score > hookScore(clips, src).score);
  for (const issue of review.issues.filter(i => i.fix)) applyOperations({ clips: coreClips(clips), options: {} }, issue.fix.operations, { sources: src });
});
test('highlights rank energetic windows, skip black and exclude used footage', () => {
  const src = analyzed();
  const top = highlights(src, { length: 4, count: 3 });
  assert.ok(top[0].start >= 19 && top[0].end <= 27, JSON.stringify(top[0]));
  assert.ok(top.every(h => h.end <= 30 || h.start >= 31.5));
  assert.ok(!highlights(src, { exclude: [{ sourceIndex: 0, start: 18, end: 28 }] }).some(h => h.start < 28 && h.end > 18));
  const rows = describeTimeline({ clips: validateClips([{ sourceIndex: 0, start: 20, end: 24 }], src).clips, sources: src });
  assert.ok(rows[0].energy > 50 && rows[0].roomAfter > 0);
});

// ---------------------------------------------------------------- agent tools + render
test('agent edit schema accepts ids/indices and rejects unknown fields', () => {
  const edit = agentTools.find(t => t.name === 'studio_edit');
  const ok = { projectId: '00000000-0000-0000-0000-000000000001', revision: 2, operations: [{ op: 'split', at: 3 }, { op: 'delete', clips: ['abc12', 0] }, { op: 'set', clip: 'all', gain: 0.5 }, { op: 'replace', clips: [{ sourceIndex: 0, start: 0, end: 2 }] }] };
  validateArguments(ok, edit.inputSchema);
  assert.throws(() => validateArguments({ ...ok, operations: [{ op: 'split', at: 3, evil: 1 }] }, edit.inputSchema), /unknown field/);
  assert.throws(() => validateArguments({ ...ok, operations: [{ op: 'rm -rf' }] }, edit.inputSchema), /unsupported/);
  assert.throws(() => validateArguments({ ...ok, operations: [{ op: 'delete', clip: 'BAD ID' }] }, edit.inputSchema));
  assert.equal(new Set(agentTools.map(t => t.name)).size, agentTools.length);
  assert.ok(agentTools.length >= 20);
});
test('agent tools route to the daemon and refuse older servers for new tools', async () => {
  const calls = [];
  const api = async (route, request) => { calls.push({ route, request }); return route === '/health' ? { service: 'AI Edit Studio', version: '0.4.0-beta.1' } : { ok: true }; };
  await callAgentTool('studio_edit', { projectId: '00000000-0000-0000-0000-000000000001', revision: 3, operations: [{ op: 'split', at: 2 }] }, api);
  assert.equal(calls.at(-1).route, '/studio/projects/00000000-0000-0000-0000-000000000001/edit');
  assert.equal(calls.at(-1).request.method, 'POST');
  await callAgentTool('studio_diff', { projectId: '00000000-0000-0000-0000-000000000001', from: 1, to: 2 }, api);
  assert.match(calls.at(-1).route, /diff\?from=1&to=2/);
  const old = async route => (route === '/health' ? { service: 'AI Edit Studio', version: '0.3.0-beta.1' } : {});
  await assert.rejects(() => callAgentTool('studio_review', { projectId: '00000000-0000-0000-0000-000000000001' }, old), /0\.4/);
  const schema = await callAgentTool('studio_schema', {}, api);
  assert.ok(schema.operations.beat_sync && schema.templates.length >= 5);
});
test('caption styles and music offset produce numeric-only filter text', () => {
  for (const style of ['box', 'bold', 'minimal']) for (const pos of ['low', 'middle', 'high']) assert.doesNotMatch(captionDrawStyle(style, pos, 1080, true), /[';\[\]]/);
  const plan = validateClips([{ sourceIndex: 0, start: 0, end: 4 }], [{ file: 'x.mp4', duration: 10, hasAudio: true }]);
  const graph = buildFilter(plan, { width: 1080, height: 1920, fps: 30, gameGain: 1, musicGain: 0.2, finish: normalizeFinish(), vertical: true, drawtext: true,
    captionFiles: [{ start: 0, end: 1, file: 'c.txt' }], captionStyle: 'bold', captionPosition: 'high' });
  assert.match(graph, /borderw=\d+:bordercolor=black:shadowx=0/); assert.match(graph, /y=h\*0.16/);
});
test('templates normalize to valid options and new options are bounded', () => {
  for (const t of TEMPLATES) assert.doesNotThrow(() => normalizeOptions(templateOptions(t.id)), t.id);
  assert.equal(templateOptions('nope'), null);
  assert.throws(() => normalizeOptions({ captionStyle: 'comic' }));
  assert.throws(() => normalizeOptions({ musicTrimStart: -1 }));
  assert.equal(normalizeOptions({ markers: [{ time: 3, label: 'x', color: 'purple' }] }).markers[0].color, 'yellow');
  const ids = validateClips([{ id: 'dup', sourceIndex: 0, start: 0, end: 1 }, { id: 'dup', sourceIndex: 0, start: 2, end: 3 }], [{ file: 'x.mp4', duration: 10 }]).clips.map(c => c.id);
  assert.equal(new Set(ids).size, 2);
});
test('review fixes from a code review stay fixed: single move, trim at a cut, black-frame trim', () => {
  const four = { clips: [...base().clips, { id: 'd', sourceIndex: 1, start: 20, end: 24, speed: 1, gain: 1 }], options: {} };
  const moved = diffEdits(four, run([{ op: 'move', clip: 'a', to: 3 }], four));
  assert.equal(moved.moved.length, 1); assert.equal(moved.moved[0].id, 'a');
  assert.throws(() => run([{ op: 'trim_to', at: 4, side: 'end' }]), /on a cut/);
  const src = [{ name: 'b.mp4', file: 'b.mp4', duration: 10, hasAudio: false, motion: [], audio: [], scenes: [], black: [{ start: 0, end: 2.5 }] }];
  const clips = validateClips([{ id: 'k', sourceIndex: 0, start: 0, end: 3.06 }, { id: 'm', sourceIndex: 0, start: 5, end: 8 }], src).clips;
  const issue = reviewEdit({ clips, sources: src, options: {} }).issues.find(i => i.code === 'BLACK_FRAMES');
  if (issue.fix) applyOperations({ clips: coreClips(clips), options: {} }, issue.fix.operations, { sources: src });
});

// ---------------------------------------------------------------- Director 0.4.1: transitions, colour, texts, limits
import { overlapOf, normalizeTexts, TRANSITIONS } from '../public/edit-ops.js';
import { normalizeTransition, normalizeColor, colorFilter } from '../src/finishing.mjs';
import { textDrawStyle } from '../src/render.mjs';
import { openApiDocument } from '../src/agent-tools.mjs';

test('transitions overlap the previous clip, are capped at half the shorter clip and shorten the edit', () => {
  const clips = [{ id: 'a', sourceIndex: 0, start: 0, end: 4 }, { id: 'b', sourceIndex: 0, start: 10, end: 11, transition: 'fade', transitionSeconds: 2 }, { id: 'c', sourceIndex: 1, start: 0, end: 4, transition: 'wipeleft', transitionSeconds: 0.5 }];
  assert.equal(overlapOf(clips[0], clips[1]), 0.5); // capped: 1 s clip / 2
  assert.equal(overlapOf(undefined, clips[0]), 0);
  const rows = layout(clips);
  assert.deepEqual(rows.map(r => [r.timelineStart, r.timelineEnd]), [[0, 4], [3.5, 4.5], [4, 8]]);
  assert.equal(totalDuration(clips), 8);
  assert.deepEqual(editPointsOf(clips), [0, 3.75, 4.25, 8]);
  const plan = validateClips(clips, [{ file: 'a.mp4', duration: 60 }, { file: 'b.mp4', duration: 60 }]);
  assert.equal(plan.actualDuration, 8); assert.equal(plan.clips[1].overlap, 0.5); assert.equal(plan.clips[0].transition, 'cut');
  assert.throws(() => validateClips([{ sourceIndex: 0, start: 0, end: 4 }, { sourceIndex: 0, start: 5, end: 9, transition: 'explode' }], [{ file: 'a.mp4', duration: 60 }]), /transition/i);
  // The first clip never gets a transition even when asked.
  assert.equal(validateClips([{ sourceIndex: 0, start: 0, end: 4, transition: 'fade' }], [{ file: 'a.mp4', duration: 60 }]).clips[0].transition, 'cut');
});
function editPointsOf(clips) { return layout(clips).reduce((acc, r) => [...acc, r.visibleEnd], [0]); }
test('render graph crossfades groups with xfade/acrossfade and joins hard cuts with frame-exact v/a concats', () => {
  const src = [{ file: 'a.mp4', duration: 60, hasAudio: true }];
  const plain = validateClips([{ sourceIndex: 0, start: 0, end: 2 }, { sourceIndex: 0, start: 5, end: 7 }], src);
  const g1 = buildFilter(plain, { width: 640, height: 360, fps: 30, gameGain: 1, musicGain: 0.2, finish: normalizeFinish() });
  assert.match(g1, /concat=n=2:v=1:a=0/); assert.match(g1, /concat=n=2:v=0:a=1/); assert.doesNotMatch(g1, /xfade/);
  const mixed = validateClips([{ sourceIndex: 0, start: 0, end: 2 }, { sourceIndex: 0, start: 5, end: 7 }, { sourceIndex: 0, start: 10, end: 12, transition: 'fadeblack', transitionSeconds: 0.4 }, { sourceIndex: 0, start: 20, end: 22 }], src);
  const g2 = buildFilter(mixed, { width: 640, height: 360, fps: 30, gameGain: 1, musicGain: 0.2, finish: normalizeFinish() });
  assert.match(g2, /concat=n=2:v=1:a=0\[gv0\]/); assert.match(g2, /xfade=transition=fadeblack:duration=0.400000:offset=3.600000/); assert.match(g2, /acrossfade=d=0.400/);
  assert.equal(mixed.actualDuration, 7.6);
});
test('per-clip colour is validated, defaults produce no filter and values become numeric eq/colorbalance/unsharp', () => {
  assert.equal(colorFilter({}), '');
  assert.match(colorFilter({ saturation: 1.2, temperature: 0.5, sharpen: 0.5, denoise: true }), /^hqdn3d.*eq=brightness=0.0000:contrast=1.0000:saturation=1.2000,colortemperature=temperature=5500:pl=1.*unsharp=5:5:0.600/);
  assert.match(colorFilter({ temperature: 0.5 }, { legacyTemperature: true }), /colorbalance=rs=0.0600/);
  assert.throws(() => normalizeColor({ contrast: 9 })); assert.throws(() => normalizeColor({ denoise: 'yes' }));
  const set = run([{ op: 'set', clip: 'a', saturation: 1.4, contrast: 1 }]).clips[0];
  assert.equal(set.saturation, 1.4); assert.equal(set.contrast, undefined, 'defaults are dropped');
  assert.throws(() => run([{ op: 'set', clip: 'a', transition: 'blur' }]), /transition/);
  const split = run([{ op: 'set', clip: 'b', transition: 'fade' }, { op: 'split', clip: 'b', sourceTime: 12 }]).clips;
  assert.equal(split[1].transition, 'fade'); assert.equal(split[2].transition, undefined, 'the second half of a split starts with a cut');
  assert.ok(Object.keys(TRANSITIONS).includes('cut'));
});
test('timeline texts validate, sort and render with numeric drawtext styles', () => {
  const texts = normalizeTexts([{ start: 5, text: 'later', style: 'lower' }, { start: 1, end: 3, text: ' Hello  world ', style: 'big', position: 'high' }]);
  assert.equal(texts[0].text, 'Hello world'); assert.equal(texts[1].end, 8); assert.equal(texts[1].position, 'left-low');
  assert.throws(() => normalizeTexts([{ start: 1, end: 1, text: 'x' }]), /times/);
  assert.throws(() => normalizeTexts([{ start: 1, text: '' }]), /missing/);
  const s = run([{ op: 'add_text', start: 2, text: 'Dag 3', style: 'big' }, { op: 'add_text', start: 0, end: 1, text: 'Intro' }, { op: 'update_text', index: 1, text: 'Dag drie' }, { op: 'remove_text', index: 0 }]);
  assert.deepEqual(s.options.texts.map(t => t.text), ['Dag drie']);
  assert.doesNotThrow(() => normalizeOptions({ texts: s.options.texts }));
  for (const style of ['title', 'lower', 'big', 'note']) for (const pos of ['center', 'low', 'high', 'left-low', 'left-high']) assert.doesNotMatch(textDrawStyle(style, pos, 1080, true), /[';\[\]]/);
  const plan = validateClips([{ sourceIndex: 0, start: 0, end: 4 }], [{ file: 'x.mp4', duration: 10, hasAudio: true }]);
  const graph = buildFilter(plan, { width: 1920, height: 1080, fps: 30, gameGain: 1, musicGain: 0.2, finish: normalizeFinish(), drawtext: true, textFiles: [{ start: 0.5, end: 2.5, style: 'lower', position: 'left-low', file: 't.txt' }] });
  assert.match(graph, /textfile='.*t.txt'.*boxcolor=0x101315@0.78.*x=w\*0.06.*alpha='min\(1,\(t-0.500\)\/0.350\)/);
});
test('limits allow long-form edits and the HTTP/OpenAPI surface mirrors the MCP tools', () => {
  const src = [{ file: 'long.mp4', duration: 7200, hasAudio: true }];
  const long = validateClips(Array.from({ length: 150 }, (_, i) => ({ sourceIndex: 0, start: i * 10, end: i * 10 + 6 })), src);
  assert.equal(long.actualDuration, 900);
  assert.throws(() => validateClips([{ sourceIndex: 0, start: 0, end: 1300 }], src), /at most 20 minutes/);
  assert.equal(normalizeOptions({ duration: 900 }).duration, 900);
  const doc = openApiDocument('http://127.0.0.1:1');
  assert.equal(doc.openapi, '3.1.0'); assert.equal(Object.keys(doc.paths).length, agentTools.length);
  assert.ok(doc.paths['/api/agent/tools/studio_edit'].post.requestBody.content['application/json'].schema.properties.operations);
  assert.ok(agentTools.some(t => t.name === 'studio_duplicate'));
});

// ---------------------------------------------------------------- Director 0.5: Ken Burns, styles, captions import, doctor, i18n
test('Ken Burns zoomEnd is validated, kept in core clips and rendered with zoompan', async () => {
  const { buildFilter: bf } = await import('../src/render.mjs');
  const src = [{ file: 'a.mp4', duration: 20, hasAudio: true }];
  const plan = validateClips([{ sourceIndex: 0, start: 0, end: 4, framing: 'fill', zoom: 1, zoomEnd: 1.4, focusX: 0.3 }], src);
  assert.equal(plan.clips[0].zoomEnd, 1.4);
  const graph = bf(plan, { width: 1280, height: 720, fps: 30, gameGain: 1, musicGain: 0.2, finish: normalizeFinish() });
  assert.match(graph, /zoompan=z='1\.0000\+\(1\.4000-1\.0000\)\*min\(1,ot\/4\.000\)'/);
  assert.throws(() => validateClips([{ sourceIndex: 0, start: 0, end: 4, zoomEnd: 1.4 }], src), /crop/);
  const s = run([{ op: 'set', clip: 'a', zoomEnd: 1.3 }]).clips[0];
  assert.equal(s.framing, 'fill'); assert.equal(coreClips([s])[0].zoomEnd, 1.3);
  assert.equal(coreClips([{ ...s, zoomEnd: 1, zoom: 1, framing: 'fit' }])[0].zoomEnd, undefined);
});
test('new agent tools: style, captions_import, doctor and frame size validate and route', async () => {
  const names = agentTools.map(t => t.name);
  for (const n of ['studio_style', 'studio_captions_import', 'studio_doctor']) assert.ok(names.includes(n), n);
  assert.ok(agentTools.length >= 23);
  const calls = [];
  const api = async (route, request) => { calls.push({ route, request }); return route === '/health' ? { service: 'AI Edit Studio', version: '0.5.0-beta.1' } : { ok: true }; };
  const id = '00000000-0000-0000-0000-000000000001';
  await callAgentTool('studio_style', { action: 'list' }, api); assert.equal(calls.at(-1).route, '/studio/styles');
  await callAgentTool('studio_style', { action: 'save', name: 'Brand', projectId: id }, api); assert.equal(calls.at(-1).request.method, 'POST');
  await callAgentTool('studio_style', { action: 'apply', name: 'Brand', projectId: id, revision: 3 }, api); assert.equal(calls.at(-1).route, `/studio/projects/${id}/style`);
  await assert.rejects(() => callAgentTool('studio_style', { action: 'apply', name: 'Brand' }, api), /projectId and revision/);
  await callAgentTool('studio_captions_import', { projectId: id, revision: 2, file: 'C:/subs.srt', sourceIndex: 0 }, api); assert.equal(calls.at(-1).route, `/studio/projects/${id}/captions`);
  await callAgentTool('studio_doctor', {}, api); assert.equal(calls.at(-1).route, '/doctor');
  await assert.rejects(() => callAgentTool('studio_frame', { projectId: id, time: 1 }, api), /sourceIndex or exportId/);
  const frame = agentTools.find(t => t.name === 'studio_frame');
  validateArguments({ projectId: id, sourceIndex: 0, time: 1, size: 'large' }, frame.inputSchema);
});
test('engine and edit messages are English', () => {
  assert.throws(() => run([{ op: 'explode' }]), /Unknown operation/);
  assert.equal(diffEdits(base(), base()).summary, 'No changes');
  assert.ok(TEMPLATES.every(t => !/[ëé]|\b(voor|met|en|van)\b/.test(`${t.name} ${t.tagline} ${t.description}`)));
});

test('review: a hook text or end call-to-action on the timeline counts as opening/end text', () => {
  const src = analyzed();
  const clips = validateClips([{ id: 'a', sourceIndex: 0, start: 20, end: 26 }, { id: 'b', sourceIndex: 0, start: 2, end: 8 }], src).clips;
  const codes = options => reviewEdit({ clips, sources: src, options }).issues.map(i => i.code);
  assert.ok(codes({}).includes('NO_TEXT'));
  assert.ok(!codes({ texts: [{ start: 0.1, end: 1.8, text: 'Wait for it', style: 'big', position: 'center' }] }).includes('NO_TEXT'));
  assert.ok(!codes({ texts: [{ start: 9, end: 11.9, text: 'Follow', style: 'callout', position: 'high' }] }).includes('NO_TEXT'));
  assert.ok(codes({ texts: [{ start: 5, end: 6, text: 'Middle', style: 'title', position: 'center' }] }).includes('NO_TEXT'));
});
