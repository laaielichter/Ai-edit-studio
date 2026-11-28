// An export follows the edit's own frame rate, and refuses an fps it cannot write (#82).
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-edit-timeline-fps-'));
process.env.GAME_TRAILER_STUDIO_DATA_ROOT = root;
const { exportTimelineProject } = await import('../src/studio.mjs');
const { exportFps } = await import('../src/longform.mjs');

let seq = 0;
/** A project on disk with one 0.6 s shot, so a 25 fps timeline writes frame 15 and a 30 fps one frame 18. */
async function projectWith(sources) {
  const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  const dir = path.join(root, 'studio', 'projects', id);
  await fs.mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify({
    schemaVersion: 2, id, name: 'rate', revision: 1, status: 'draft', progress: 0, createdAt: now, updatedAt: now,
    options: {}, sources,
    plan: { clips: [{ id: 'a', sourceIndex: 0, start: 0, end: 0.6 }], actualDuration: 0.6 },
  }));
  return id;
}
const video = (fps) => ({ file: `/media/s${fps}.mp4`, name: `s${fps}.mp4`, duration: 10, hasAudio: true, video: { fps } });
/** Rewrite the plan's clips (the helper above always starts with a single shot on source 0). */
async function useClips(id, clips) {
  const dir = path.join(root, 'studio', 'projects', id);
  const record = JSON.parse(await fs.readFile(path.join(dir, 'project.json'), 'utf8'));
  record.plan.clips = clips;
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(record));
}

test('no fps: a 25 fps source exports at 25 instead of 30', async () => {
  const id = await projectWith([video(25)]);
  const out = await exportTimelineProject(id, { format: 'edl' });
  assert.equal(out.fps, 25);
  assert.equal(out.fpsSource, 'source', 'the result says the rate came from the footage, not from a request');
  assert.equal('warnings' in out, false, 'a single-rate edit has no mixed-rate warning');
  assert.match(out.content, /FCM: NON-DROP FRAME/);
  assert.match(out.content, /00:00:00:00 00:00:00:15 /, '0.6 s is 15 frames at 25 fps');
});

test('no fps: 30000/1001 becomes 29.97 and stays drop-frame', async () => {
  const id = await projectWith([video(30000 / 1001)]);
  const out = await exportTimelineProject(id, { format: 'edl' });
  assert.equal(out.fps, 29.97);
  assert.equal(out.fpsSource, 'source');
  assert.match(out.content, /FCM: DROP FRAME/);
});

test('no fps: a still image (no rate) falls back to 30', async () => {
  const id = await projectWith([{ file: '/media/still.png', name: 'still.png', duration: 10, still: true, video: { fps: 0 } }]);
  const out = await exportTimelineProject(id, { format: 'edl' });
  assert.equal(out.fps, 30);
  assert.equal(out.fpsSource, 'default', 'stills have no rate of their own, so the result says 30 is the default');
  assert.match(out.content, /00:00:00:00 00:00:00:18 /, '0.6 s is 18 frames at 30 fps');
});

test('no fps: the first video source the edit uses decides, not a later one', async () => {
  const id = await projectWith([video(60), video(24)]);
  await useClips(id, [{ id: 'b', sourceIndex: 1, start: 0, end: 0.6 }]);
  const out = await exportTimelineProject(id, { format: 'edl' });
  assert.equal(out.fps, 24);
  assert.equal(out.fpsSource, 'source');
});

test('an fps that is asked for still wins, and the result says it was requested', async () => {
  const id = await projectWith([video(25)]);
  const out = await exportTimelineProject(id, { format: 'edl', fps: 50 });
  assert.equal(out.fps, 50);
  assert.equal(out.fpsSource, 'request');
});

test('mixed-rate sources: the first one wins and a warning names the other rates (#82 point 4)', async () => {
  const id = await projectWith([video(25), video(30000 / 1001), video(50)]);
  await useClips(id, [
    { id: 'a', sourceIndex: 0, start: 0, end: 0.6 },
    { id: 'b', sourceIndex: 1, start: 0, end: 0.6 },
    { id: 'c', sourceIndex: 2, start: 0, end: 0.6 },
  ]);
  const out = await exportTimelineProject(id, { format: 'edl' });
  assert.equal(out.fps, 25);
  assert.equal(out.fpsSource, 'source');
  assert.deepEqual(out.warnings, ['Mixed-rate sources: the whole edit is written at 25 fps from the first video source; other sources are 29.97, 50 fps.']);
});

test('mixed-rate warning survives an explicitly requested fps, and chapters keep their own warnings', async () => {
  const id = await projectWith([video(25), video(60)]);
  await useClips(id, [
    { id: 'a', sourceIndex: 0, start: 0, end: 30 },
    { id: 'b', sourceIndex: 1, start: 0, end: 30 },
    { id: 'c', sourceIndex: 1, start: 0, end: 30 },
  ]);
  const explicit = await exportTimelineProject(id, { format: 'edl', fps: 24 });
  assert.equal(explicit.fpsSource, 'request');
  assert.equal(explicit.warnings.length, 1);
  assert.match(explicit.warnings[0], /60 fps/);
  // chapters already uses `warnings` for YouTube's rules (#60): both kinds must be returned.
  const chapters = await exportTimelineProject(id, { format: 'chapters' });
  assert.ok(chapters.warnings.some(w => /Mixed-rate sources/.test(w)));
  assert.ok(chapters.warnings.some(w => /YouTube/.test(w)), 'the chapter warnings are not lost');
});

test('exportFps reports where each rate came from', () => {
  assert.deepEqual(exportFps(50, [], [video(25)]), { fps: 50, from: 'request', sourceRates: [25] });
  assert.deepEqual(exportFps(undefined, [], [video(25)]), { fps: 25, from: 'source', sourceRates: [25] });
  assert.deepEqual(exportFps(undefined, [], []), { fps: 30, from: 'default', sourceRates: [] });
  assert.throws(() => exportFps(48, [], [video(25)]), /must be one of/);
});

test('an fps that cannot be written is refused, with the list, instead of exporting at 30', async () => {
  const id = await projectWith([video(25)]);
  await assert.rejects(() => exportTimelineProject(id, { format: 'edl', fps: 48 }), err => {
    assert.equal(err.code, 'INVALID_ARGUMENTS');
    for (const rate of ['23.976', '24', '25', '29.97', '30', '50', '59.94', '60']) assert.ok(err.message.includes(rate), `message should list ${rate}: ${err.message}`);
    return true;
  });
  await assert.rejects(() => exportTimelineProject(id, { format: 'edl', fps: 0 }), err => err.code === 'INVALID_ARGUMENTS');
});

test('the tool schema offers exactly the eight rates', async () => {
  const { agentTools } = await import('../src/agent-tools.mjs');
  const tool = agentTools.find(t => t.name === 'studio_export_timeline');
  assert.deepEqual(tool.inputSchema.properties.fps.enum, [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]);
});
