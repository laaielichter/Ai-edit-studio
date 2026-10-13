import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOperations, normalizeSections, sectionSpans, totalDuration, layout } from '../public/edit-ops.js';
import { buildFilter, segmentBoundaries } from '../src/render.mjs';
import { validateClips } from '../src/editing.mjs';
import { fitDuration, searchWords, searchProject, assembleFromScript, scriptLines, multicamPlan, exportTimeline, timecode } from '../src/longform.mjs';
import { correlate, onsets } from '../src/sync.mjs';
import { agentTools, validateArguments, callAgentTool, OPERATIONS } from '../src/agent-tools.mjs';

const src = (duration, extra = {}) => ({ duration, hasAudio: true, file: `/media/s${duration}.mp4`, name: `s${duration}`, ...extra });
// Analysis-like curves: motion + loudness every 0.5 s; `hot` marks loud/moving stretches.
const analysed = (duration, hot = () => false) => src(duration, {
  motion: Array.from({ length: duration * 2 }, (_, i) => ({ time: i / 2, value: hot(i / 2) ? 0.9 : 0.1 })),
  audio: Array.from({ length: duration * 2 }, (_, i) => ({ time: i / 2, value: hot(i / 2) ? -12 : -35 })),
});
const plan = (clips, sources) => validateClips(clips, sources);
const id = '00000000-0000-0000-0000-000000000001';

test('sections: normalise, spans follow the anchor shot, move_block, anchors survive deletes', () => {
  const clips = ['a', 'b', 'c', 'd', 'e'].map((x, i) => ({ id: x, sourceIndex: 0, start: i * 3, end: i * 3 + 2 }));
  assert.throws(() => normalizeSections([{ name: 'A', clip: 'a' }, { name: 'a', clip: 'b' }]), /unique/);
  assert.throws(() => normalizeSections([{ name: '', clip: 'a' }]), /name/);
  const sections = normalizeSections([{ name: 'Intro', clip: 'a' }, { name: 'Middle', clip: 'c', color: 'pink' }]);
  assert.equal(sections[1].color, 'yellow', 'unknown colours fall back');
  const spans = sectionSpans(clips, sections);
  assert.deepEqual(spans.map(s => [s.name, s.clipIds.join(''), s.start, s.duration]), [['Intro', 'ab', 0, 4], ['Middle', 'cde', 4, 6]]);
  const moved = applyOperations({ clips, options: { sections } }, [{ op: 'move_block', clips: ['c', 'd', 'e'], before: 'a' }]);
  assert.deepEqual(moved.clips.map(c => c.id).join(''), 'cdeab');
  assert.equal(sectionSpans(moved.clips, moved.options.sections)[0].name, 'Middle');
  assert.throws(() => applyOperations({ clips, options: {} }, [{ op: 'move_block', clips: ['a', 'b'], before: 'b' }]), /inside the block/);
  const cut = applyOperations({ clips, options: { sections } }, [{ op: 'delete', clips: ['c'] }]);
  assert.deepEqual(cut.options.sections.map(s => [s.name, s.clip]), [['Intro', 'a'], ['Middle', 'd']], 'a section whose first shot is deleted moves to the next shot');
  const gone = applyOperations({ clips, options: { sections } }, [{ op: 'delete', clips: ['c', 'd', 'e'] }]);
  assert.deepEqual(gone.options.sections.map(s => s.name), ['Intro']);
});

test('frame-exact placement: shots get the frames between their rounded cut points, joins keep v/a separate', () => {
  const sources = [src(100), src(100)];
  const clips = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, sourceIndex: i % 2, start: i * 2, end: i * 2 + 1.217 }));
  const p = plan(clips, sources);
  const graph = buildFilter(p, { width: 640, height: 360, fps: 30, title: '', drawtext: true });
  const frames = [...graph.matchAll(/trim=end_frame=(\d+)/g)].map(m => Number(m[1]));
  assert.equal(frames.length, 40);
  assert.equal(frames.reduce((a, b) => a + b, 0), Math.round(p.actualDuration * 30), 'no drift: total frames match the plan');
  assert.ok(frames.every(f => f === 36 || f === 37));
  assert.match(graph, /concat=n=40:v=1:a=0\[gv0\]/); assert.match(graph, /concat=n=40:v=0:a=1\[ga0\]/);
  assert.doesNotMatch(graph, /v=1:a=1/, 'a joint concat would pad every shot and push later cuts');
  const xf = plan([{ sourceIndex: 0, start: 0, end: 3.31 }, { sourceIndex: 1, start: 0, end: 3, transition: 'fade', transitionSeconds: 0.5 }], sources);
  const m = buildFilter(xf, { width: 640, height: 360, fps: 30, drawtext: true }).match(/xfade=transition=fade:duration=([\d.]+):offset=([\d.]+)/);
  assert.ok(Number.isInteger(Math.round(Number(m[2]) * 30 * 1e6) / 1e6), 'transition starts on a frame');
});

test('segments: only at free hard cuts, stable under edits elsewhere; segment and audio stages', () => {
  const clips = Array.from({ length: 60 }, (_, i) => ({ id: `k${i}x`, sourceIndex: 0, start: i * 5, end: i * 5 + 4, duration: 4, ...(i === 20 ? { transition: 'fade', transitionSeconds: 0.5 } : {}) }));
  const segs = segmentBoundaries(clips, { minSeconds: 20, maxSeconds: 40 });
  assert.ok(segs.length >= 5);
  assert.deepEqual(segs.flat(), clips.map((_, i) => i), 'every shot once, in order');
  assert.ok(!segs.some(s => s[0] === 20), 'never at a transition');
  const blocked = [[30, 90]];
  const free = segmentBoundaries(clips, { minSeconds: 20, maxSeconds: 40, blocked });
  const at = s => s[0] * 4; // hard cuts of 4 s shots before index 20
  assert.ok(free.slice(1).every(s => s[0] > 20 || !(at(s) > 30 && at(s) < 90)), 'no cut inside a caption/text/layer span');
  // Removing a shot in the first segment leaves later boundaries (by clip id) unchanged.
  const later = segs.slice(3).map(s => clips[s[0]].id);
  const segs2 = segmentBoundaries(clips.filter((_, i) => i !== 2), { minSeconds: 20, maxSeconds: 40 });
  const ids2 = segs2.map(s => clips.filter((_, i) => i !== 2)[s[0]].id);
  assert.ok(later.every(x => ids2.includes(x)), 'content-defined boundaries resync after an edit');

  const sources = [src(400)];
  const p = plan(clips.slice(0, 6).map(({ duration, ...c }) => c), sources);
  const seg = buildFilter(p, { width: 640, height: 360, fps: 30, title: 'T', titleFile: '/tmp/t.txt', drawtext: true, stage: 'segment', label: 'L', labelFile: '/tmp/l.txt' });
  assert.match(seg, /\[vout\]/); assert.match(seg, /\[acat\]anull\[aout\]/);
  assert.doesNotMatch(seg, /loudnorm/, 'segments keep raw programme sound');
  const audio = buildFilter(p, { width: 640, height: 360, fps: 30, drawtext: true, stage: 'audio', programAudioInput: 1, loudnessTarget: -14 });
  assert.match(audio, /^\[1:a:0\]aresample/); assert.doesNotMatch(audio, /\[vout\]|drawtext|:v:0/, 'the finishing pass touches only sound');
  assert.match(audio, /loudnorm=I=-14/);
});

test('fit to length: pauses and fillers, weak sentences, weak shots, then trims; hook and finale kept', () => {
  const sources = [analysed(120, t => (t > 40 && t < 50) || t < 5 || t > 110)];
  const clips = Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, sourceIndex: 0, start: i * 12, end: i * 12 + 10 }));
  const words = []; let t = 12;
  for (let i = 0; i < 40; i++) { words.push({ start: t, end: t + 0.3, text: i % 10 === 3 ? 'um' : `w${i}` }); t += i === 20 ? 2 : 0.4; }
  const r = fitDuration({ clips, sources, transcripts: { 0: { words, language: 'en' } }, target: 60 });
  assert.ok(r.after <= 60.31 && r.after >= 55, `${r.before} → ${r.after}`);
  assert.equal(r.before, 100);
  assert.equal(r.clips[0].id, 'f0', 'hook kept'); assert.equal(r.clips.at(-1).id, 'f9', 'finale kept');
  assert.ok(Math.abs(totalDuration(r.clips) - r.after) < 0.01, 'the returned timeline has the reported length');
  assert.ok(r.operations.length >= 2);
  assert.ok(r.steps.some(s => /filler/.test(s)));
  // Two shots only: the opening and closing shots shorten from the inside.
  const two = [{ id: 'h', sourceIndex: 0, start: 0, end: 15 }, { id: 'z', sourceIndex: 0, start: 100, end: 115 }];
  const r2 = fitDuration({ clips: two, sources, target: 20 });
  const a2 = r2.clips;
  assert.ok(r2.after <= 20.31, String(r2.after));
  assert.equal(a2[0].start, 0, 'the first moment stays'); assert.equal(a2[1].end, 115, 'the last moment stays');
  assert.throws(() => fitDuration({ clips, sources, target: 1 }), /3 seconds/);
});

test('search: typo tolerant transcript search, labels, markers; insert ops only for unused speech', () => {
  const words = 'welcome back today we build a tiny rocket engine from scratch'.split(' ').map((text, i) => ({ start: i, end: i + 0.8, text }));
  const hits = searchWords(words, 'tiny rockit');
  assert.equal(words[hits[0].from].text, 'tiny'); assert.equal(words[hits[0].to].text, 'rocket');
  const clips = [{ id: 'a', sourceIndex: 0, start: 0, end: 4, label: 'Intro shot' }];
  const found = searchProject({ clips, sources: [src(20)], options: { markers: [{ time: 2, label: 'intro beat' }] }, transcripts: { 0: { words } }, query: 'intro' });
  assert.deepEqual(found.map(h => h.kind).sort(), ['marker', 'shot']);
  const speech = searchProject({ clips, sources: [src(20)], transcripts: { 0: { words } }, query: 'rocket engine', kinds: ['speech'] });
  assert.ok(speech[0].insert && !speech[0].inEdit, 'unused passage comes with an insert operation');
  const used = searchProject({ clips, sources: [src(20)], transcripts: { 0: { words } }, query: 'welcome back', kinds: ['speech'] });
  assert.ok(used[0].inEdit && used[0].timeline != null && !used[0].insert);
  assert.throws(() => searchProject({ clips, sources: [], query: ' ' }), /empty/);
});

test('script → rough cut: lines matched in order, no footage reused, unmatched reported', () => {
  const words = [];
  'the quick brown fox jumps over the lazy dog then a slow green turtle walks home'.split(' ').forEach((text, i) => words.push({ start: i * 0.5, end: i * 0.5 + 0.4, text }));
  assert.deepEqual(scriptLines('# Title here\n- a slow green turtle\n1. x\n\n2) the quick brown fox'), ['Title here', 'a slow green turtle', 'the quick brown fox']);
  const r = assembleFromScript({ script: 'A slow green turtle walks\nThe quick brown fox!\nbananas and pears today', transcripts: { 0: { words } }, sources: [src(20)] });
  assert.equal(r.matched, 2); assert.deepEqual(r.unmatched.map(u => u.line), [3]);
  assert.ok(r.clips[0].start > r.clips[1].start, 'script order, not source order');
  assert.ok(r.clips[1].end <= r.clips[0].start, 'no overlap between passages');
});

test('multicam: picture follows the louder (relative) microphone with shot limits', () => {
  const turn = t => Math.floor(t / 10) % 2 === 0; // A talks 0–10, 20–30…; B 10–20, 30–40…
  const camA = src(60, { audio: Array.from({ length: 120 }, (_, i) => ({ time: i / 2, value: turn(i / 2) ? -10 : -30 })) });
  const camB = src(57, { audio: Array.from({ length: 114 }, (_, i) => ({ time: i / 2, value: turn(i / 2 + 3) ? -32 : -12 })) }); // started 3 s later
  const clips = multicamPlan({ sources: [camA, camB], cams: [{ sourceIndex: 0, offset: 0 }, { sourceIndex: 1, offset: 3 }], from: 3, to: 60, minShot: 2, maxShot: 30 });
  let t = 3, right = 0, total = 0;
  for (const c of clips) {
    for (let x = 0.25; x < c.end - c.start; x += 0.5) { const ref = t + x; if (ref % 10 > 1 && ref % 10 < 9) { total++; if ((c.sourceIndex === 0) === turn(ref)) right++; } }
    t += c.end - c.start;
  }
  assert.ok(right / total > 0.95, `${right}/${total}`);
  assert.ok(clips.every(c => c.gain === 0 && c.end - c.start >= 1.9));
  assert.ok(Math.abs(t - 60) < 0.01, 'continuous coverage of the synced range');
});

test('audio sync: cross-correlation finds the offset and reports confidence', () => {
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const env = Float64Array.from({ length: 6000 }, () => (rnd() < 0.08 ? 1000 + rnd() * 3000 : 50 + rnd() * 30));
  const later = env.slice(437); // the second recorder started 4.37 s later
  const r = correlate(onsets(env), onsets(later), { maxOffset: 30 });
  assert.equal(r.offset, 4.37); assert.ok(r.confidence >= 1.5);
  const earlier = Float64Array.from([...Array.from({ length: 250 }, () => 60), ...env]);
  assert.equal(correlate(onsets(env), onsets(earlier), { maxOffset: 30 }).offset, -2.5);
});

test('timeline export: EDL, CSV, chapters, FCPXML and OTIO are well formed', () => {
  const sources = [src(40, { name: 'cam & co', file: 'C:\\media\\cam a.mp4', video: { width: 1920, height: 1080 } }), src(40)];
  const clips = [{ id: 'a', sourceIndex: 0, start: 1, end: 5, label: 'Hello' }, { id: 'b', sourceIndex: 1, start: 10, end: 13, speed: 1.5 }, { id: 'c', sourceIndex: 0, start: 20, end: 24, transition: 'fade', transitionSeconds: 0.5 }];
  const options = { sections: [{ name: 'Part B', clip: 'b' }], markers: [{ time: 1, label: 'm' }], narration: '/v/voice.wav', narrationTrimStart: 2 };
  assert.equal(timecode(3661.5, 30), '01:01:01:15');
  const edl = exportTimeline({ format: 'edl', clips, sources, options, name: 'Ünï', fps: 30 }).content;
  assert.equal(edl.split('\r\n').filter(l => /^\d{3} /.test(l)).length, 3);
  assert.match(edl, /^TITLE: n/); assert.match(edl, /M2 +AX +045\.0/); assert.match(edl, /01:00:00:00 01:00:04:00/);
  const csv = exportTimeline({ format: 'csv', clips, sources, options }).content.split('\r\n');
  assert.equal(csv.length, 4); assert.match(csv[2], /"Part B"/);
  assert.equal(exportTimeline({ format: 'chapters', clips, sources, options }).content, '00:00 Intro\n00:04 Part B');
  const fcp = exportTimeline({ format: 'fcpxml', clips, sources, options, name: 'A & B' }).content;
  assert.match(fcp, /<project name="A &amp; B">/); assert.match(fcp, /file:\/\/\/C:\/media\/cam%20a\.mp4/); assert.match(fcp, /lane="-1" name="Voice"/);
  assert.equal((fcp.match(/<asset-clip ref="a/g) ?? []).length, 3);
  const otio = JSON.parse(exportTimeline({ format: 'otio', clips, sources, options }).content);
  assert.equal(otio.tracks.children[0].children.length, 3); assert.equal(otio.tracks.children[1].kind, 'Audio');
  const rb = layout(clips)[1];
  assert.equal(otio.tracks.children[0].children[1].source_range.duration.value, Math.round((rb.visibleEnd - rb.visibleStart) * 1.5 * 30), 'speed changes map to source frames');
  assert.throws(() => exportTimeline({ format: 'aaf', clips, sources }), /format/);
});

test('0.8 tools: 46 tools, schemas validate, version gate, routes', async () => {
  assert.ok(agentTools.length >= 46);
  assert.ok(OPERATIONS.includes('move_block'));
  const schema = n => agentTools.find(t => t.name === `studio_${n}`).inputSchema;
  validateArguments({ projectId: id, revision: 2, from: 10, to: 20, quality: 'final' }, schema('render_range'));
  validateArguments({ projectId: id, revision: 2, target: 179, dryRun: true }, schema('fit_duration'));
  validateArguments({ projectId: id, revision: 2, action: 'set', name: 'Intro', props: { saturation: 1.2 } }, schema('sections'));
  validateArguments({ projectId: id, query: 'rocket', kinds: ['speech', 'moments'] }, schema('search'));
  validateArguments({ projectId: id, revision: 1, script: 'a b\nc d' }, schema('assemble'));
  validateArguments({ projectId: id, revision: 1, cameras: [0, 1], audioSource: 0 }, schema('multicam'));
  validateArguments({ projectId: id, format: 'otio', fps: 25 }, schema('export_timeline'));
  validateArguments({ projectId: id, action: 'resolve', id: 'abcdef12', reply: 'ok' }, schema('comments'));
  validateArguments({ projectId: id, action: 'make', height: 540 }, schema('proxies'));
  validateArguments({ projectId: id, revision: 3, operations: [{ op: 'move_block', clips: ['a', 'b'], before: null }] }, schema('edit'));
  validateArguments({ projectId: id, revision: 3, options: { sections: [{ name: 'A', clip: 'abc' }], segmentedRender: 'off' } }, schema('update'));
  assert.throws(() => validateArguments({ projectId: id, action: 'make', height: 1080 }, schema('proxies')), /unsupported/);
  assert.throws(() => validateArguments({ projectId: id, format: 'aaf' }, schema('export_timeline')), /unsupported/);
  const calls = [];
  const api = async (route, req = {}) => { calls.push([route, req.method ?? 'GET', req.body]); return route === '/health' ? { service: 'AI Edit Studio', version: '0.8.0-beta.1' } : {}; };
  await callAgentTool('studio_search', { projectId: id, query: 'x' }, api);
  await callAgentTool('studio_export_timeline', { projectId: id, format: 'edl' }, api);
  await callAgentTool('studio_render_range', { projectId: id, from: 1, to: 9 }, api);
  assert.deepEqual(calls.filter(c => c[0] !== '/health').map(c => c[0]), [`/studio/projects/${id}/search`, `/studio/projects/${id}/export-timeline`, `/studio/projects/${id}/render-range`]);
  const old = async route => (route === '/health' ? { service: 'AI Edit Studio', version: '0.7.0-beta.1' } : {});
  await assert.rejects(callAgentTool('studio_sections', { projectId: id }, old), /RESTART_REQUIRED|predates/);
});
