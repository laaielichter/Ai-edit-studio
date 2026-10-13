import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOperations, normalizeOverlay, coreClip, totalDuration } from '../public/edit-ops.js';
import { normalizeCaptions, mapCaptions, cueWords } from '../public/captions.js';
import { wordsToCaptions } from '../public/transcript.js';
import { buildAss, assText } from '../src/captions-ass.mjs';
import { findClips, sentences } from '../src/clips.mjs';
import { parseQcLog, judgeQc } from '../src/qc.mjs';
import { audioWindows, buildFilter } from '../src/render.mjs';
import { normalizeOptions, validateClips } from '../src/editing.mjs';
import { BUILTIN_RECIPES, validateRecipe } from '../src/recipes.mjs';
import { agentTools, validateArguments, callAgentTool } from '../src/agent-tools.mjs';

const sources = [{ duration: 20 }, { duration: 20 }];
const st = (clips, options = {}) => ({ clips, options });

test('captions carry word timings through normalize and mapping', () => {
  const [cue] = normalizeCaptions([{ sourceIndex: 0, start: 2, end: 4, text: 'Lock the target', words: [{ start: 2, end: 2.5, text: 'Lock' }, { start: 2.6, end: 3, text: 'the' }, { start: 3.1, end: 3.9, text: 'target' }, { start: 9, end: 10, text: 'outside' }] }]);
  assert.equal(cue.words.length, 3, 'words outside the cue are dropped');
  const mapped = mapCaptions([cue], [{ sourceIndex: 0, start: 3, end: 6 }]);
  assert.deepEqual(mapped[0].words.map(w => w.text), ['target']);
  assert.equal(mapped[0].text, 'target', 'a cue cut by an edit shows only its visible words');
  assert.equal(cueWords({ start: 0, end: 2, text: 'a bb' }).length, 2);
  const cues = wordsToCaptions([{ start: 0, end: 0.3, text: 'Hi' }, { start: 0.4, end: 0.8, text: 'there.' }], 0);
  assert.deepEqual(cues[0].words.map(w => w.text), ['Hi', 'there.']);
});

test('ASS animated captions: karaoke, pop, highlight, words; text is neutralised', () => {
  const cues = [{ start: 1, end: 3, text: 'Lock the {target}', words: [{ start: 1, end: 1.5, text: 'Lock' }, { start: 1.6, end: 2, text: 'the' }, { start: 2.1, end: 3, text: '{target}\\N' }] }];
  const k = buildAss(cues, { width: 1080, height: 1920, animation: 'karaoke', colors: { accent: '#FFD84D' } });
  assert.match(k, /PlayResX: 1080/); assert.match(k, /Style: Cap,/);
  assert.equal((k.match(/^Dialogue:/gm) ?? []).length, 3, 'one event per active word');
  assert.match(k, /\{\\c&H004DD8FF&\\fscx108\\fscy108\}Lock\{\\r\}/, 'active word in accent (BGR)');
  assert.ok(!/\{target\}/.test(k.split('[Events]')[1].replace(/\{\\[^}]*\}/g, '')), 'user braces cannot inject overrides');
  assert.equal(assText('a{b}\\c'), 'a(b)/c');
  const pop = buildAss(cues, { width: 1080, height: 1920, animation: 'pop', upper: true });
  assert.match(pop, /\\t\(0,90,\\fscx112/); assert.match(pop, /LOCK/);
  assert.match(buildAss(cues, { animation: 'highlight' }), /\\3c&H00/);
  assert.equal((buildAss(cues, { animation: 'words' }).match(/^Dialogue:/gm) ?? []).length, 3);
  assert.match(buildAss([{ start: 0, end: 1, text: 'static' }], { animation: 'none', style: 'box' }), /,3,\d+,0,2,/, 'box style uses an opaque box');
});

test('clip finder: sentence-aligned, ranked, non-overlapping', () => {
  const words = [];
  for (let i = 0; i < 120; i++) words.push({ start: i * 0.5, end: i * 0.5 + 0.4, text: i % 10 === 9 ? `w${i}.` : `w${i}` });
  assert.equal(sentences(words).length, 12);
  const motion = [], audio = [];
  for (let t = 0; t < 60; t += 0.25) { motion.push({ time: t, value: t > 30 && t < 45 ? 40 : 8 }); audio.push({ time: t, value: -20 }); }
  const src = [{ duration: 60, motion, audio, scenes: [], black: [], video: { width: 1920, height: 1080 } }];
  const clips = findClips({ sources: src, transcripts: { 0: { words } }, count: 3, minSeconds: 8, maxSeconds: 16 });
  assert.equal(clips.length, 3);
  assert.ok(clips[0].start >= 25 && clips[0].end <= 50, `best clip ${clips[0].start}–${clips[0].end} covers the action`);
  assert.ok(clips.every(c => c.complete && c.duration >= 8 && c.duration <= 16));
  for (let i = 0; i < clips.length; i++) for (let j = i + 1; j < clips.length; j++) assert.ok(Math.min(clips[i].end, clips[j].end) <= Math.max(clips[i].start, clips[j].start));
  const blind = findClips({ sources: src, count: 2, minSeconds: 10, maxSeconds: 20 });
  assert.equal(blind.length, 2); assert.equal(blind[0].speech, null);
  assert.throws(() => findClips({ sources: src, minSeconds: 30, maxSeconds: 10 }), /minSeconds/);
});

test('QC parses ebur128/blackdetect/freezedetect/silencedetect and judges', () => {
  const log = `[Parsed_ebur128_0] t: 1 M: -20 S: -20 I: -30.0 LUFS LRA: 0 LU
[blackdetect @ x] black_start:5.0 black_end:6.2 black_duration:1.2
[freezedetect @ x] lavfi.freezedetect.freeze_start: 10
[freezedetect @ x] lavfi.freezedetect.freeze_end: 13.5
[silencedetect @ x] silence_start: 2.5
[silencedetect @ x] silence_end: 5.1 | silence_duration: 2.6
[Parsed_ebur128_0] Summary:
  Integrated loudness:
    I:         -17.2 LUFS
  Loudness range:
    LRA:         6.1 LU
  True peak:
    Peak:       -0.4 dBFS`;
  const m = parseQcLog(log);
  assert.equal(m.loudness, -17.2, 'integrated value from the summary, not a running value');
  assert.equal(m.truePeak, -0.4); assert.equal(m.range, 6.1);
  assert.deepEqual(m.black, [{ start: 5, end: 6.2 }]); assert.deepEqual(m.freeze, [{ start: 10, end: 13.5 }]); assert.deepEqual(m.silence, [{ start: 2.5, end: 5.1 }]);
  const v = judgeQc(m, { duration: 20, expectedDuration: 20, loudnessTarget: -14, bytes: 20 * 1024 ** 2, maxBytes: 16 * 1024 ** 2 });
  assert.deepEqual(v.issues.map(i => i.code).sort(), ['BLACK', 'FROZEN', 'LOUDNESS', 'SILENCE', 'TOO_LARGE', 'TRUE_PEAK']);
  assert.equal(v.passed, false);
  assert.equal(judgeQc({ ...m, black: [], freeze: [], silence: [], loudness: -14.3, truePeak: -2 }, { duration: 20, loudnessTarget: -14 }).score, 100);
});

test('J/L cuts keep the programme length and only move the sound cut', () => {
  const plan = validateClips([{ sourceIndex: 0, start: 2, end: 6 }, { sourceIndex: 1, start: 4, end: 8, audioShift: -0.5 }, { sourceIndex: 0, start: 10, end: 14, audioShift: 0.7 }], [{ duration: 20, file: '/a.mp4' }, { duration: 20, file: '/b.mp4' }]);
  const w = audioWindows(plan.clips);
  assert.deepEqual(w.map(x => +x.duration.toFixed(3)), [3.5, 5.2, 3.3]);
  assert.equal(+w.reduce((s, x) => s + x.duration, 0).toFixed(3), plan.actualDuration);
  assert.equal(w[1].aStart, 3.5, 'J-cut: incoming sound starts earlier in its source');
  assert.equal(+w[1].aEnd.toFixed(3), 8.7, 'L-cut on the next cut: this sound carries on');
  const graph = buildFilter(plan, { width: 1280, height: 720, fps: 30 });
  assert.match(graph, /concat=n=3:v=1:a=0\[gv0\]/); assert.match(graph, /concat=n=3:v=0:a=1\[ga0\]/);
  const clamp = audioWindows(validateClips([{ sourceIndex: 0, start: 0, end: 3 }, { sourceIndex: 1, start: 0.2, end: 3, audioShift: -1.5 }], [{ duration: 20, file: '/a' }, { duration: 20, file: '/b' }]).clips);
  assert.equal(clamp[1].aStart, 0, 'a J-cut never reads before the start of the recording');
});

test('overlays, voice enhance and loudness reach the filter graph', () => {
  const plan = validateClips([{ sourceIndex: 0, start: 0, end: 6 }], [{ duration: 20, file: '/a.mp4', hasAudio: true }]);
  const overlays = [normalizeOverlay({ sourceIndex: 1, start: 0, end: 2, at: 1, mode: 'pip', position: 'bottom-left', size: 0.3, gain: 0.5 }), normalizeOverlay({ sourceIndex: 1, start: 3, end: 5, at: 3, mode: 'full' })];
  const g = buildFilter(plan, { width: 1280, height: 720, fps: 30, overlays, overlayInputs: [2, 4], overlayAudioInputs: [3, null], voiceEnhance: 'strong', loudnessTarget: -16 });
  assert.match(g, /\[vcat\]\[ov0\]overlay=x=\d+:y=H-h-\d+:eof_action=pass:enable='between\(t,1\.000,3\.000\)'\[ob0\]/);
  assert.match(g, /crop=1280:720,setsar=1,format=yuva420p,setpts=PTS-STARTPTS\+3\.000\/TB\[ov1\]/);
  assert.match(g, /afftdn=nr=18/); assert.match(g, /deesser/);
  assert.match(g, /loudnorm=I=-16:TP=-1\.5:LRA=11/);
  assert.match(g, /\[3:a:0\].*adelay=1000:all=1/); assert.match(g, /amix=inputs=2/);
  assert.equal(normalizeOptions({}).loudnessTarget, -14);
  assert.equal(normalizeOptions({ loudnessTarget: 'off' }).loudnessTarget, null);
  assert.throws(() => normalizeOptions({ overlays: [{ sourceIndex: 0, start: 0, end: 2, at: 0, mode: 'sideways' }] }), /mode/);
});

test('punch-in, speed ramp, overlay ops and audioShift round-trip', () => {
  let n = applyOperations(st([{ id: 'a', sourceIndex: 0, start: 0, end: 8 }]), [{ op: 'punch_in', seconds: 2, zoom: 1.2 }], { sources });
  assert.deepEqual(n.clips.map(c => [c.start, c.end, c.zoom ?? 1]), [[0, 2, 1], [2, 4, 1.2], [4, 6, 1], [6, 8, 1.2]]);
  assert.throws(() => applyOperations(st([{ id: 'a', sourceIndex: 0, start: 0, end: 8 }]), [{ op: 'punch_in' }], { sources }), /beat/);
  n = applyOperations(st([{ id: 'a', sourceIndex: 0, start: 0, end: 8 }]), [{ op: 'speed_ramp', clip: 'a', from: 1, to: 0.5, steps: 4 }], { sources });
  assert.deepEqual(n.clips.map(c => c.speed), [1, 0.833, 0.667, 0.5]);
  assert.ok(totalDuration(n.clips) > 8 && n.clips.at(-1).end === 8);
  n = applyOperations(st([{ id: 'a', sourceIndex: 0, start: 0, end: 8 }]), [{ op: 'add_overlay', sourceIndex: 1, start: 1, end: 4, at: 2 }, { op: 'update_overlay', index: 0, mode: 'pip' }, { op: 'set', clip: 'a', audioShift: -0.3 }], { sources });
  assert.equal(n.options.overlays[0].mode, 'pip'); assert.equal(coreClip(n.clips[0]).audioShift, -0.3);
  assert.throws(() => applyOperations(st([{ id: 'a', sourceIndex: 0, start: 0, end: 8 }]), [{ op: 'add_overlay', sourceIndex: 1, start: 15, end: 25, at: 0 }], { sources }), /beyond/);
  n = applyOperations(n, [{ op: 'remove_overlay', index: 0 }], { sources });
  assert.deepEqual(n.options.overlays, []);
});

test('recipes validate; 0.7 tools validate and route', async () => {
  const tools = agentTools.map(t => t.name);
  for (const r of Object.values(BUILTIN_RECIPES)) validateRecipe(r, tools);
  assert.throws(() => validateRecipe({ steps: [{ tool: 'rm_rf' }] }, tools), /unknown/);
  assert.throws(() => validateRecipe({ steps: [{ tool: 'studio_recipe' }] }, tools), /disallowed/);
  assert.ok(agentTools.length >= 36);
  const id = '00000000-0000-0000-0000-000000000001';
  const schema = n => agentTools.find(t => t.name === `studio_${n}`).inputSchema;
  validateArguments({ action: 'run', name: 'social-pack', projectId: id, inputs: { platform: 'reels', anything: 1 } }, schema('recipe'));
  validateArguments({ projectId: id, count: 5, create: true, render: true }, schema('find_clips'));
  validateArguments({ projectId: id, revision: 3, operations: [{ op: 'add_overlay', sourceIndex: 0, start: 1, end: 2, at: 0, mode: 'pip', position: 'top-left' }, { op: 'speed_ramp', clip: 'abc', from: 1, to: 0.5, steps: 4 }, { op: 'set', clip: 'abc', audioShift: -0.5 }] }, schema('edit'));
  validateArguments({ projectId: id, revision: 1, options: { voiceEnhance: 'light', loudnessTarget: 'off', captionAnimation: 'karaoke' } }, schema('update'));
  const calls = [];
  const api = async (route, request) => { calls.push({ route, request }); return route === '/health' ? { service: 'AI Edit Studio', version: '0.7.0-beta.1' } : { ok: true }; };
  await callAgentTool('studio_wait', { projectId: id, timeoutSeconds: 10 }, api); assert.equal(calls.at(-1).route, `/studio/projects/${id}/wait`);
  await callAgentTool('studio_qc', { projectId: id }, api); assert.equal(calls.at(-1).route, `/studio/projects/${id}/qc`);
  await callAgentTool('studio_find_clips', { projectId: id, count: 3 }, api); assert.equal(calls.at(-1).route, `/studio/projects/${id}/find-clips`);
  await callAgentTool('studio_queue', { action: 'cancel', jobId: id }, api); assert.deepEqual(calls.at(-1).request.body, { cancel: id });
  await callAgentTool('studio_recipe', { action: 'run', name: 'social-pack', projectId: id }, api); assert.equal(calls.at(-1).route, '/studio/recipes/run');
  await callAgentTool('studio_freeze', { projectId: id, revision: 2, at: 3 }, api); assert.equal(calls.at(-1).route, `/studio/projects/${id}/freeze`);
  const old = async route => (route === '/health' ? { service: 'AI Edit Studio', version: '0.6.0-beta.1' } : {});
  await assert.rejects(() => callAgentTool('studio_qc', { projectId: id }, old), /restart Studio 0\.7/);
});
