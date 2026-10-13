import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOperations, coreClip, normalizeTexts } from '../public/edit-ops.js';
import { buildFilter, textDrawStyle, filterPath } from '../src/render.mjs';
import { colorFilter } from '../src/finishing.mjs';
import { validateClips, normalizeOptions } from '../src/editing.mjs';
import { BUILTIN_LUTS, cubeText, validateCube, colorCorrection, autoTarget, averageStats, musicFitPlan, SFX, normalizeSfx, autoSfx, audioRepairAdvice, normalizeAudioRepair, audioRepairChain,
  levelMatch, emphasisTimes, autoBrollPlan, nameTokens } from '../src/polish.mjs';
import { agentTools, validateArguments, callAgentTool } from '../src/agent-tools.mjs';

const id = '00000000-0000-0000-0000-000000000009';
const src = (duration, extra = {}) => ({ duration, hasAudio: true, file: `/media/${extra.name ?? `s${duration}`}.mp4`, name: extra.name ?? `s${duration}.mp4`, ...extra });
const curves = (duration, loud = () => -20, motion = () => 0.3) => ({
  audio: Array.from({ length: duration * 2 }, (_, i) => ({ time: i / 2, value: loud(i / 2) })),
  motion: Array.from({ length: duration * 2 }, (_, i) => ({ time: i / 2, value: motion(i / 2) })),
});

test('LUTs: built-in cubes are valid 3D LUTs; validation rejects broken files', () => {
  for (const key of Object.keys(BUILTIN_LUTS)) {
    const text = cubeText(key, 9);
    assert.deepEqual(validateCube(text), { size: 9 });
    const rows = text.trim().split('\n').filter(l => /^[\d.]+ [\d.]+ [\d.]+$/.test(l));
    assert.equal(rows.length, 729);
  }
  const mono = cubeText('mono-contrast', 5).trim().split('\n').filter(l => /^[\d.]+ /.test(l));
  assert.ok(mono.every(l => { const [r, g, b] = l.split(' '); return r === g && g === b; }), 'mono look is grey');
  assert.throws(() => validateCube('LUT_1D_SIZE 4\n0 0 0'), /3D/);
  assert.throws(() => validateCube('LUT_3D_SIZE 2\n0 0 0\n1 1 1'), /rows/);
  assert.throws(() => validateCube('LUT_3D_SIZE 2\n' + '0 0 x\n'.repeat(8)), /Invalid/);
});

test('render graph: LUT with strength, stabilisation, progress bar, effects, repair, temperature', () => {
  const sources = [src(30)];
  const plan = validateClips([{ sourceIndex: 0, start: 0, end: 4, stabilize: 0.5, temperature: 0.5 }, { sourceIndex: 0, start: 6, end: 9 }], sources);
  plan.clips[0].stabFile = '/data/stab/a b.trf';
  const g = buildFilter(plan, { width: 1280, height: 720, fps: 30, drawtext: true, lutFile: '/luts/teal.cube', lutStrength: 0.6, progressBar: 'bottom', sfxInputIndex: 4, audioRepair: { hum: 60, declip: true, denoise: 0.5 }, musicInputIndex: null });
  assert.ok(g.includes(`vidstabtransform=input='${filterPath('/data/stab/a b.trf')}':smoothing=24`), 'stabilisation reads the escaped .trf path');
  assert.ok(g.includes(`[lutB]lut3d=file='${filterPath('/luts/teal.cube')}'[lutC];\n[lutC][lutA]blend=all_mode=normal:all_opacity=0.600`), 'LUT with strength blends over the original');
  assert.match(g, /overlay=x='-w\+w\*min\(1,\(t\+0\.000\)\/7\.000\)':y=H-h:shortest=1/);
  assert.match(g, /\[4:a:0\]aresample.*\[sfx\]/); assert.match(g, /\[foreground\]\[sfx\]amix/);
  assert.match(g, /adeclip,bandreject=f=60:width_type=q:w=24,bandreject=f=120.*afftdn=nr=15\.0/);
  assert.match(g, /colortemperature=temperature=5500:pl=1/);
  const full = buildFilter(plan, { width: 1280, height: 720, fps: 30, drawtext: true, lutFile: '/l.cube', lutStrength: 1 });
  assert.ok(full.includes(`,lut3d=file='${filterPath('/l.cube')}'`)); assert.doesNotMatch(full, /blend=/);
  assert.match(buildFilter({ ...plan, clips: [{ ...plan.clips[0], stabFile: undefined }] , actualDuration: 4 }, { width: 640, height: 360, fps: 30 }), /deshake=rx=32/, 'without a measured transform, deshake');
  const seg = buildFilter(plan, { width: 1280, height: 720, fps: 30, stage: 'segment', progressBar: 'top', timeOffset: 42.5, programDuration: 300 });
  assert.match(seg, /\(t\+42\.500\)\/300\.000\)':y=0/, 'segments use programme time for the bar');
  assert.match(colorFilter({ temperature: -1 }), /temperature=8500/);
  assert.match(textDrawStyle('callout', 'high', 1920, false, { accent: '#FFB400' }), /fontcolor=0x111111.*boxcolor=0xFFB400@0\.96/);
  assert.match(textDrawStyle('callout', 'high', 1920, false, { accent: '#203040' }), /fontcolor=0xFFFFFF/);
  assert.deepEqual(normalizeTexts([{ start: 1, text: 'Subscribe', style: 'callout' }])[0].style, 'callout');
});

test('clip stabilise prop, options for LUT/progress bar/effects/repair validate', () => {
  const st = { clips: [{ id: 'a', sourceIndex: 0, start: 0, end: 5 }], options: {} };
  const s1 = applyOperations(st, [{ op: 'set', clip: 'a', stabilize: 0.7 }]);
  assert.equal(s1.clips[0].stabilize, 0.7);
  assert.equal(applyOperations(s1, [{ op: 'set', clip: 'a', stabilize: 0 }]).clips[0].stabilize, undefined);
  assert.equal(coreClip({ ...s1.clips[0], stabilize: 0 }).stabilize, undefined);
  assert.throws(() => applyOperations(st, [{ op: 'set', clip: 'a', stabilize: 2 }]), /stabilize/);
  const o = normalizeOptions({ lut: '/x.cube', lutStrength: 0.5, progressBar: 'top', sfx: [{ time: 3, kind: 'pop' }, { time: 1, kind: 'whoosh', gain: 1 }], audioRepair: { hum: 50, declick: true } });
  assert.deepEqual(o.sfx.map(x => x.kind), ['whoosh', 'pop']);
  assert.deepEqual(o.audioRepair, { hum: 50, declick: true, declip: false, denoise: 0 });
  assert.equal(normalizeOptions({ audioRepair: { hum: 0 } }).audioRepair, null);
  assert.throws(() => normalizeOptions({ sfx: [{ time: 1, kind: 'boom' }] }), /kind/);
  assert.throws(() => normalizeOptions({ audioRepair: { hum: 55 } }), /hum/);
  assert.throws(() => normalizeOptions({ progressBar: 'left' }));
  assert.equal(audioRepairChain(null), '');
  assert.ok(Object.values(SFX).every(x => x.seconds > 0 && /d=/.test(x.graph)));
});

test('colour correction: dark warm shot toward a neutral reference; auto targets', () => {
  const ref = { y: 120, lo: 30, hi: 220, u: 128, v: 128, sat: 40 };
  const warm = { y: 80, lo: 25, hi: 150, u: 123, v: 133, sat: 40 };
  const fix = colorCorrection(warm, ref, 1);
  assert.ok(fix.brightness > 0.05 && fix.contrast > 1.2 && fix.temperature < -0.5, JSON.stringify(fix));
  assert.equal(fix.saturation, 1);
  assert.deepEqual(colorCorrection(ref, ref, 1), { brightness: 0, contrast: 1, saturation: 1, temperature: 0 }, 'identical → no change');
  const half = colorCorrection(warm, ref, 0.5);
  assert.ok(Math.abs(half.temperature) < Math.abs(fix.temperature) && half.contrast < fix.contrast, 'strength scales');
  assert.equal(colorCorrection({ ...warm, sat: 1 }, ref, 1).temperature, 0, 'black and white footage is not tinted');
  const t = autoTarget(warm); assert.equal(t.cast, 0); assert.ok(t.y > warm.y && t.range >= 170);
  assert.deepEqual(averageStats([{ y: 10, lo: 0, hi: 20, u: 1, v: 1, sat: 2 }, { y: 20, lo: 0, hi: 40, u: 3, v: 3, sat: 4 }]), { y: 15, lo: 0, hi: 30, u: 2, v: 2, sat: 3 });
});

test('music fit: bars removed or a phrase repeated; ending kept; start on a beat', () => {
  const beats = Array.from({ length: 400 }, (_, i) => i * 0.5); // 120 bpm, bars of 2 s
  const short = musicFitPlan({ duration: 180, beats, bpm: 120, target: 61.3 });
  assert.equal(short.parts.at(-1).end, 180, 'the real ending stays');
  assert.equal(short.parts.length, 2);
  assert.equal((short.parts[1].start - short.parts[0].end) % 2, 0, 'whole bars removed');
  assert.ok(Math.abs(short.length - 61.3) < 0.3, String(short.length));
  assert.equal(short.trimStart % 0.5, 0, 'starts on a beat');
  const long = musicFitPlan({ duration: 60, beats: beats.filter(b => b < 60), bpm: 120, target: 150.2 });
  assert.equal(long.parts.at(-1).end, 60); assert.ok(long.parts.length > 3 && Math.abs(long.length - 150.2) < 0.3);
  const noGrid = musicFitPlan({ duration: 100, beats: [], target: 40 });
  assert.match(noGrid.method, /no beat grid/); assert.equal(noGrid.parts.at(-1).end, 100);
  assert.match(musicFitPlan({ duration: 30.1, beats, bpm: 120, target: 30 }).method, /already/);
  assert.throws(() => musicFitPlan({ duration: 0, target: 10 }), /length/);
});

test('sound effects: auto placement on transitions, texts, punch-ins and finale', () => {
  const clips = [{ id: 'a', sourceIndex: 0, start: 0, end: 4 }, { id: 'b', sourceIndex: 0, start: 4, end: 7, zoom: 1.2, framing: 'fill' }, { id: 'c', sourceIndex: 1, start: 0, end: 4, transition: 'fade', transitionSeconds: 0.6 }, { id: 'd', sourceIndex: 1, start: 5, end: 12 }];
  const fx = autoSfx({ clips, options: { texts: [{ start: 1, end: 2, text: 'x' }] } });
  const kinds = fx.map(x => x.kind);
  assert.ok(['whoosh', 'pop', 'hit', 'riser'].every(k => kinds.includes(k)), JSON.stringify(fx));
  assert.ok(fx.find(x => x.kind === 'hit' && Math.abs(x.time - 4) < 0.01), 'hit on the punch-in');
  assert.ok(fx.every((x, i) => !i || x.time - fx[i - 1].time >= 0.45), 'spaced');
  assert.deepEqual(autoSfx({ clips, options: {}, kinds: ['pop'] }), []);
  assert.equal(normalizeSfx([{ time: 2, kind: 'drop' }])[0].gain, 0.7);
});

test('audio repair advice, chain and shot level matching', () => {
  assert.deepEqual(audioRepairAdvice({ bands: { 50: -40, 60: -70, ref: -72 }, peak: -3, clipped: 0, noiseFloor: -70 }), { hum: 50, declip: false, declick: false, denoise: 0 });
  assert.equal(audioRepairAdvice({ bands: { 50: -70, 60: -38, ref: -71 }, peak: 0, clipped: 300, noiseFloor: -40 }).hum, 60);
  const a = audioRepairAdvice({ bands: { 50: -60, 60: -60, ref: -61 }, peak: 0, clipped: 300, noiseFloor: -40 });
  assert.equal(a.hum, 0); assert.ok(a.declip && a.denoise > 0 && a.denoise <= 0.6);
  assert.match(audioRepairChain({ declick: true }), /^adeclick,$/);
  const sources = [src(20, curves(20, t => (t < 10 ? -30 : -12)))];
  const gains = levelMatch([{ id: 'q', sourceIndex: 0, start: 0, end: 8 }, { id: 'l', sourceIndex: 0, start: 11, end: 19 }, { id: 'm', sourceIndex: 0, start: 12, end: 18, gain: 0 }], sources);
  assert.equal(gains.length, 1); assert.ok(gains[0].gain > 1 || gains[0].gain < 1);
  assert.deepEqual(normalizeAudioRepair({ hum: 0, denoise: 0 }), null);
});

test('emphasis times and automatic B-roll by keyword, else calm stretches', () => {
  const sources = [src(60, { name: 'talk.mp4', ...curves(60) }), src(20, { name: 'Rocket launch.mp4', ...curves(20, () => -20, t => (t > 10 ? 0.9 : 0.1)) }), src(20, { name: 'IMG_0042.mov', ...curves(20) })];
  const clips = [{ id: 'a', sourceIndex: 0, start: 0, end: 30 }];
  const words = 'hello there. today we fly our rocket ! it goes up high . what next ? more soon'.split(' ').map((text, i) => ({ start: 1 + i * 1.3, end: 1.9 + i * 1.3, text }));
  const times = emphasisTimes({ clips, sources, transcripts: { 0: { words } }, minGap: 2 });
  assert.ok(times.length >= 3 && times.every((t, i) => !i || t - times[i - 1] >= 2), JSON.stringify(times));
  assert.deepEqual(nameTokens('Rocket launch (final) 2.mp4'), ['rocket', 'launch']);
  const plan = autoBrollPlan({ clips, sources, transcripts: { 0: { words } }, seconds: 3, maxPerMinute: 4 });
  const rocketAt = words.find(w => w.text === 'rocket').start;
  assert.equal(plan.method, 'keywords');
  assert.ok(plan.overlays.some(o => o.sourceIndex === 1 && Math.abs(o.at - rocketAt + 0.15) < 0.01 && o.start >= 10), JSON.stringify(plan.overlays));
  const calm = autoBrollPlan({ clips, sources, transcripts: {}, seconds: 3, maxPerMinute: 4 });
  assert.equal(calm.method, 'calm stretches'); assert.ok(calm.overlays.length >= 1 && calm.overlays.every(o => o.at > 2 && o.at + 3 < 27));
  assert.equal(autoBrollPlan({ clips: [{ id: 'x', sourceIndex: 0, start: 0, end: 30 }], sources: [sources[0]] }).overlays.length, 0, 'no pool, no B-roll');
  const st = applyOperations({ clips, options: {} }, [{ op: 'punch_in', clips: ['a'], times, zoom: 1.15, focusY: 0.4 }]);
  assert.equal(st.clips.length, times.length + 1); assert.equal(st.clips[1].zoom, 1.15); assert.equal(st.clips[1].focusY, 0.4);
});

test('speed_ranges speeds pauses up instead of cutting; quiet ranges from the analysis', async () => {
  const st = { clips: [{ id: 'a', sourceIndex: 0, start: 0, end: 10 }, { id: 'b', sourceIndex: 1, start: 0, end: 3 }], options: {} };
  const r = applyOperations(st, [{ op: 'speed_ranges', sourceIndex: 0, ranges: [{ start: 2, end: 4 }, { start: 6, end: 6.3 }], speed: 2 }]);
  assert.deepEqual(r.clips.map(c => [c.start, c.end, c.speed ?? 1]), [[0, 2, 1], [2, 4, 2], [4, 10, 1], [0, 3, 1]], 'tiny ranges are left alone');
  assert.throws(() => applyOperations(st, [{ op: 'speed_ranges', sourceIndex: 0, ranges: [{ start: 1, end: 3 }], speed: 3 }]), /speed/);
  const { quietRanges } = await import('../src/polish.mjs');
  const q = quietRanges(src(20, curves(20, t => (t >= 5 && t < 9 ? -60 : -15))), { min: 1.2 });
  assert.deepEqual(q, [{ start: 5.15, end: 8.85 }]);
});

test('0.9 tools: 56+ tools, schemas, gate, batch routing', async () => {
  assert.ok(agentTools.length >= 56);
  const schema = n => agentTools.find(t => t.name === `studio_${n}`).inputSchema;
  validateArguments({ projectId: id, action: 'apply', name: 'teal-orange', strength: 0.5, revision: 2 }, schema('lut'));
  validateArguments({ action: 'list' }, schema('lut'));
  validateArguments({ projectId: id, revision: 2, mode: 'match', reference: 'abc', strength: 1 }, schema('color_match'));
  validateArguments({ projectId: id, revision: 2, clips: ['a', 'b'], strength: 0.6 }, schema('stabilize'));
  validateArguments({ projectId: id, revision: 2, dryRun: true }, schema('music_fit'));
  validateArguments({ projectId: id, action: 'apply', hum: 60, denoise: 0.3, levelShots: true, revision: 1 }, schema('audio_repair'));
  validateArguments({ projectId: id, action: 'add', time: 3, kind: 'whoosh', revision: 1 }, schema('sfx'));
  validateArguments({ projectId: id, revision: 1, style: 'push', amount: 1.1 }, schema('auto_zoom'));
  validateArguments({ projectId: id, revision: 1, pool: [2], mode: 'pip' }, schema('auto_broll'));
  validateArguments({ tool: 'studio_lut', arguments: { action: 'apply', name: 'x' }, projects: 'all' }, schema('batch'));
  validateArguments({ projectId: id, layout: 'stack', audio: 'mix' }, schema('compare'));
  validateArguments({ projectId: id, revision: 1, formats: ['landscape', 'stems'] }, schema('render'));
  validateArguments({ projectId: id, revision: 1, options: { lut: '/a.cube', progressBar: 'bottom', sfx: [{ time: 1, kind: 'pop' }], audioRepair: null } }, schema('update'));
  assert.throws(() => validateArguments({ projectId: id, action: 'add', kind: 'boom' }, schema('sfx')), /unsupported/);
  const calls = [];
  const projects = [{ id, name: 'Alpha cut' }, { id: '00000000-0000-0000-0000-00000000000a', name: 'Beta cut' }];
  const api = async (route, req = {}) => {
    calls.push([route, req.method ?? 'GET', req.body]);
    if (route === '/health') return { service: 'AI Edit Studio', version: '0.9.0-beta.1' };
    if (route === '/studio/projects') return { projects };
    if (/^\/studio\/projects\/[0-9a-f-]+$/.test(route)) return { project: { id: route.split('/').pop(), revision: 7 } };
    return { project: { revision: 8 }, diff: { summary: 'LUT' } };
  };
  const r = await callAgentTool('studio_batch', { tool: 'lut', arguments: { action: 'apply', name: 'warm-film' }, match: 'alpha' }, api);
  assert.equal(r.projects, 1); assert.equal(r.ok, 1);
  assert.deepEqual(calls.find(c => c[0].endsWith('/lut'))[2], { action: 'apply', name: 'warm-film', revision: 7 });
  await assert.rejects(callAgentTool('studio_batch', { tool: 'recipe', arguments: {}, projects: 'all' }, api), /per-project tool/);
  await assert.rejects(callAgentTool('studio_batch', { tool: 'lut', arguments: {} }, api), /projects/);
  await callAgentTool('studio_lut', { action: 'list' }, api);
  assert.ok(calls.some(c => c[0] === '/studio/luts'));
  const old = async route => (route === '/health' ? { service: 'AI Edit Studio', version: '0.8.0-beta.1' } : {});
  await assert.rejects(callAgentTool('studio_sfx', { projectId: id }, old), /predates/);
});
