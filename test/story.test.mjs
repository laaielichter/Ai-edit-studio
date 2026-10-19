// 0.11: story documents — compile, beat timing, events, warnings, scene rendering and the two tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compileStory, storySummary, renderGeneratedScene, STORY_GUIDE, readSeconds } from '../src/story.mjs';
import { agentTools, callAgentTool } from '../src/agent-tools.mjs';
import { findFfmpegTools } from '../src/ffmpeg.mjs';

const base = (over = {}) => ({ ...STORY_GUIDE.example, size: '720', ...over });
const scene = (id, extra = {}) => ({ id, kind: 'title', beats: 4, lines: ['Hello *there*'], ...extra });

test('the guide example compiles on the beat grid, with events and a drop on a bar line', () => {
  const c = compileStory(base());
  const sum = storySummary(c);
  assert.equal(c.version, 'aes.story/1');
  assert.ok(sum.scenes.length >= 3);
  sum.scenes.forEach((s, i) => { if (i) assert.ok(Math.abs(s.start / c.beat - Math.round(s.start / c.beat)) < 0.01, `${s.id} starts on a beat`); });
  assert.ok(c.drops.every(d => d.onBar), 'guide example drops sit on bar lines');
  assert.equal(c.events[`${c.scenes[0].id}.in`], 0);
  assert.equal(c.cuts.length, c.scenes.length - 1);
});

test('timing: beats × (60 / bpm), transition overlaps the previous scene and ends on the beat', () => {
  const c = compileStory({ version: 'aes.story/1', music: { bpm: 120 }, scenes: [scene('a'), scene('b', { transition: 'fadeblack', transitionSeconds: 0.25 })] });
  assert.equal(c.beat, 0.5);
  assert.equal(c.scenes[1].timelineStart, 2);
  assert.equal(c.scenes[1].clipSeconds, 2.25);
  assert.equal(c.duration, 4);
});

test('mistakes are refused or warned in plain words', () => {
  assert.throws(() => compileStory({ scenes: [] }), /scenes/);
  assert.throws(() => compileStory({ scenes: [scene('a'), scene('a')] }), /used twice/);
  assert.throws(() => compileStory({ deliver: 'cinema', scenes: [scene('a')] }), /deliver must be/);
  assert.throws(() => compileStory({ scenes: [scene('a')], drops: [{ beat: 99 }] }), /outside the story/);
  const off = compileStory({ music: { bpm: 120 }, scenes: [scene('a')], drops: [{ beat: 3 }] });
  assert.ok(off.warnings.some(w => w.code === 'DROP_OFF_BAR'));
  const fast = compileStory({ music: { bpm: 120 }, scenes: [scene('a', { beats: 1, lines: ['One two three four five six seven'] })] });
  assert.ok(fast.warnings.some(w => w.code === 'READ_TIME'));
  assert.ok(readSeconds('one two') > 0.8);
});

test('studio_guide and studio_apply dryRun work without a running server', async () => {
  assert.ok(agentTools.find(t => t.name === 'studio_apply') && agentTools.find(t => t.name === 'studio_guide'));
  assert.equal((await callAgentTool('studio_guide', { topic: 'story' })).example.version, 'aes.story/1');
  const calls = [], api = async (route, req) => { calls.push({ route, req }); return route === '/health' ? { service: 'AI Edit Studio', version: '0.11.0' } : { ok: true }; };
  await callAgentTool('studio_apply', { story: base(), dryRun: true }, api);
  assert.equal(calls.at(-1).route, '/studio/story/apply');
  assert.equal(calls.at(-1).req.body.dryRun, true);
  await callAgentTool('studio_apply', { action: 'status', buildId: '00000000-0000-0000-0000-000000000001' }, api);
  assert.equal(calls.at(-1).route, '/studio/story/builds/00000000-0000-0000-0000-000000000001');
  await assert.rejects(callAgentTool('studio_apply', {}, api), /needs story/);
  await assert.rejects(callAgentTool('studio_apply', { story: base() }, async r => (r === '/health' ? { service: 'AI Edit Studio', version: '0.10.1' } : {})), /predates/);
});

test('a generated scene renders to the right size and length, and is reused the second time', async t => {
  let tools; try { tools = findFfmpegTools(); } catch { return t.skip('FFmpeg not available'); }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aes-story-'));
  const c = compileStory({ version: 'aes.story/1', size: '720', music: { bpm: 120 }, scenes: [scene('a', { beats: 2 })] });
  const first = await renderGeneratedScene(c, c.scenes[0], dir, { ffmpeg: tools.ffmpeg });
  assert.equal(first.reused, false);
  const again = await renderGeneratedScene(c, c.scenes[0], dir, { ffmpeg: tools.ffmpeg });
  assert.equal(again.reused, true);
  assert.equal(again.file, first.file);
  const { probeMedia } = await import('../src/ffmpeg.mjs');
  const info = await probeMedia(first.file);
  assert.equal(info.video.width, 720); assert.equal(info.video.height, 1280);
  assert.ok(info.duration >= 1 && info.duration < 1.2, `duration ${info.duration}`);
  await fs.rm(dir, { recursive: true, force: true });
});
