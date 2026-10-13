// Director 0.10: the music engine (composer, tempo map, renderer) and the studio_music tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-edit-music-'));
process.env.GAME_TRAILER_STUDIO_DATA_ROOT = root;
delete process.env.ELEVENLABS_API_KEY;
const { compose, tempoMap, voice, chordOf, STYLES } = await import('../src/music/compose.mjs');
const { generateMusic, styleList } = await import('../src/music/engine.mjs');
const { lufs, peakDb, bandLevels, SR } = await import('../src/music/dsp.mjs');
const { providerPrompt, saveProviderKey, providerStatus, elevenLabsCompose } = await import('../src/music/index.mjs');
const { agentTools, callAgentTool, validateArguments } = await import('../src/agent-tools.mjs');

const read24 = buf => { const n = (buf.length - 44) / 6, L = new Float32Array(n), R = new Float32Array(n); for (let i = 0; i < n; i++) { L[i] = buf.readIntLE(44 + i * 6, 3) / 8388607; R[i] = buf.readIntLE(47 + i * 6, 3) / 8388607; } return { L, R }; };

test('tempo map: every structural anchor lands exactly on a bar line; impossible ones become accents', () => {
  const m = tempoMap({ anchors: [1.875, 15, 22.5], duration: 25, bpmRange: [118, 132], defaultBpm: 128 });
  assert.equal(m.bpm, 128);
  for (const t of [1.875, 15, 22.5]) { const k = m.anchorBar.get(t); assert.ok(k !== undefined, `anchor ${t}`); assert.ok(Math.abs(m.bars[k].t - t) < 1e-9); }
  assert.equal(m.bars[0].t, 0, 'starts on a downbeat');
  // odd times: tempo bends per segment (within 6 %) but anchors stay exact
  const odd = tempoMap({ anchors: [12.3, 40, 57.5], duration: 60, bpmRange: [84, 100], defaultBpm: 90 });
  for (const t of [12.3, 40, 57.5]) assert.ok(Math.abs(odd.bars[odd.anchorBar.get(t)].t - t) < 1e-9);
  for (const sg of odd.segments) assert.ok(Math.abs(sg.bpm - odd.bpm) / odd.bpm <= 0.061, JSON.stringify(odd.segments));
  // two drops 1 s apart cannot both be bar lines at a sane tempo: one becomes an accent
  const close = tempoMap({ anchors: [5, 6, 27.5], duration: 30, bpmRange: [134, 150], defaultBpm: 140 });
  assert.ok(close.dropped.includes(6));
});

test('composer: same seed = same piece, sections follow the drops, harmony is voice-led', () => {
  const a = compose({ style: 'pop', duration: 25, drops: [1.875, 15], seed: 4 }), b = compose({ style: 'pop', duration: 25, drops: [1.875, 15], seed: 4 });
  assert.deepEqual(a.tracks.lead.map(e => e.midi), b.tracks.lead.map(e => e.midi));
  assert.deepEqual(a.sections.map(s => [s.name, s.start]), [['build', 0], ['drop', 1.875], ['build', 13.125], ['drop2', 15], ['end', 22.5]]);
  const c = compose({ style: 'pop', duration: 25, drops: [1.875, 15], seed: 5 });
  assert.notDeepEqual(a.tracks.lead.map(e => e.midi), c.tracks.lead.map(e => e.midi));
  // beats are exact and inside the piece; the final hit has a kick on it
  assert.ok(a.beats.every(t => t >= 0 && t <= 25));
  assert.ok(a.tracks.kick.some(e => Math.abs(e.t - 22.5) < 1e-9));
  // builds before drops leave the last eighth empty (no drums), so the drop hits harder
  for (const e of a.tracks.clap) assert.ok(!(e.t > 1.875 - 0.12 && e.t < 1.875), `gap before drop at ${e.t}`);
  // voice leading: neighbouring chords move little and stay in range
  let prev = null, moved = 0;
  for (const deg of [5, 2, 6, 0]) { const v = voice(chordOf(9, 'minor', deg), prev, { lo: 53, hi: 77 }); assert.ok(v[0] >= 53 && v.at(-1) <= 77); if (prev) moved += v.reduce((s, m, k) => s + Math.abs(m - prev[k]), 0); prev = v; }
  assert.ok(moved <= 24, `total movement ${moved}`);
  // the hook stays in its register and mostly moves by step
  const leaps = a.tracks.lead.filter(e => e.kind === 'pluck').map(e => e.midi).reduce((acc, m, i, arr) => acc + (i && Math.abs(m - arr[i - 1]) > 7 ? 1 : 0), 0);
  assert.ok(leaps <= 3, `${leaps} big leaps`);
});

test('engine renders every style: exact length, mastered loudness, ceiling, sane tonal balance', { timeout: 120_000 }, () => {
  assert.deepEqual(styleList().map(s => s.id).sort(), Object.keys(STYLES).sort());
  for (const style of Object.keys(STYLES)) {
    const res = generateMusic({ style, duration: 8, seed: 3, drops: [2] });
    const buf = read24(res.wav);
    assert.equal(buf.L.length, 8 * SR, style);
    assert.ok(buf.L.every(Number.isFinite) && buf.R.every(Number.isFinite), `${style} finite`);
    assert.ok(peakDb(buf) <= -0.9, `${style} peak ${peakDb(buf)}`);
    assert.ok(Math.abs(lufs(buf) - STYLES[style].master) < 1.6, `${style} loudness ${lufs(buf)} vs ${STYLES[style].master}`);
    const bands = bandLevels(buf), top = Math.max(...bands);
    // low end leads, the top octave is clearly quieter than the mids (not harsh), nothing missing in the mids
    assert.ok(bands[9] < bands[5] - 3, `${style} 16 kHz too loud`);
    assert.ok(bands[4] > top - 20 && bands[5] > top - 20, `${style} mids missing`);
    assert.equal(res.report.style, style);
    assert.ok(res.report.anchors.every(a => a.onBar || a.accent));
  }
});

test('stems come out time-aligned and peak-safe', { timeout: 60_000 }, () => {
  const res = generateMusic({ style: 'house', duration: 6, seed: 1, stems: true });
  assert.deepEqual(Object.keys(res.stems).sort(), ['bass', 'drums', 'fx', 'music']);
  for (const b of Object.values(res.stems)) { const s = read24(b); assert.equal(s.L.length, 6 * SR); assert.ok(peakDb(s) <= -0.99); }
});

test('online provider: prompt from the brief, keys stored locally and validated, no key = clear error', async () => {
  const p = providerPrompt({ style: 'pop', mood: 'emotional', bpm: 128, drops: [1.875, 15], duration: 25 });
  assert.match(p, /Instrumental pop drop/); assert.match(p, /1\.9 s and 15\.0 s/); assert.match(p, /no vocals/);
  assert.equal((await providerStatus()).find(x => x.id === 'elevenlabs').configured, false);
  await assert.rejects(saveProviderKey('elevenlabs', 'bad key!'), /API key/);
  await assert.rejects(elevenLabsCompose({ prompt: 'x', seconds: 10 }, path.join(root, 'x.mp3')), /API key/);
  const saved = await saveProviderKey('elevenlabs', 'sk_test_0123456789abcdef');
  assert.equal(saved.configured, true); assert.equal(saved.keySource, 'saved'); assert.equal(JSON.stringify(saved).includes('0123456789'), false);
  assert.equal((await saveProviderKey('elevenlabs', '')).configured, false);
});

test('studio_music tool: schema, routing and version gate', async () => {
  const spec = agentTools.find(t => t.name === 'studio_music');
  assert.ok(spec);
  const id = '00000000-0000-0000-0000-00000000000a';
  validateArguments({ projectId: id, revision: 3, style: 'trap', mood: 'dark', key: 'F#m', drops: [2.5, 9], seed: 7 }, spec.inputSchema);
  validateArguments({ projectId: id, revision: 3, drops: 'auto' }, spec.inputSchema);
  assert.throws(() => validateArguments({ projectId: id, style: 'polka' }, spec.inputSchema), /unsupported/);
  const calls = [], api = async (route, req) => { calls.push({ route, req }); return route === '/health' ? { service: 'AI Edit Studio', version: '0.10.0-beta.1' } : { ok: true }; };
  await callAgentTool('studio_music', { action: 'styles' }, api); assert.equal(calls.at(-1).route, '/studio/music/styles');
  await callAgentTool('studio_music', { projectId: id, revision: 3, style: 'pop' }, api); assert.equal(calls.at(-1).route, `/studio/projects/${id}/music`);
  await assert.rejects(callAgentTool('studio_music', { style: 'pop' }, api), /projectId and revision/);
  const old = async route => (route === '/health' ? { service: 'AI Edit Studio', version: '0.9.0-beta.2' } : {});
  await assert.rejects(callAgentTool('studio_music', { projectId: id, revision: 1 }, old), /predates/);
});

test.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
