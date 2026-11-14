// studio_freeze at or after the end of the edit is refused with INVALID_ARGUMENTS (#132):
// the range is checked before FFmpeg runs, nothing is added to the project, and a time
// inside the edit still gives a freeze frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The data root is read when the modules load, so set it before the dynamic imports.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-edit-freeze-'));
process.env.GAME_TRAILER_STUDIO_DATA_ROOT = root;
const { freezeFrame, getProject } = await import('../src/studio.mjs');
const { validateClips } = await import('../src/editing.mjs');
const { findFfmpegTools } = await import('../src/ffmpeg.mjs');
const { runProcess } = await import('../src/process.mjs');

let seeded = 0;
// One 20 s shot of a 20 s recording: the edit is 20 s long.
async function seed(file) {
  seeded += 1;
  const id = `55555555-5555-4555-8555-5555555555${String(seeded).padStart(2, '0')}`;
  const stat = await fs.stat(file);
  const sources = [{ name: 'a.mp4', file, duration: 20, hasAudio: true, audio: [], black: [], motion: [], scenes: [], size: stat.size, mtimeMs: stat.mtimeMs }];
  const dir = path.join(root, 'studio', 'projects', id);
  await fs.mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify({
    schemaVersion: 2, id, revision: 2, name: 'Freeze', options: {}, sources,
    plan: { ...validateClips([{ id: 'a', sourceIndex: 0, start: 0, end: 20 }], sources), style: 'flight' },
    status: 'draft', progress: 0, message: 'Analyzed.', warnings: [], exports: [], createdAt: now, updatedAt: now,
  }));
  return { id, dir };
}

const stills = async dir => (await fs.readdir(dir)).filter(name => /^freeze-.*\.png$/.test(name));

test('a freeze at or after the end of the edit is refused with INVALID_ARGUMENTS, before FFmpeg runs', async () => {
  // The file is never read: the range check comes before the still is grabbed.
  const file = path.join(root, 'a.mp4');
  await fs.writeFile(file, 'not a video; the range check comes first');
  for (const at of [20, 100]) {
    const { id, dir } = await seed(file);
    await assert.rejects(() => freezeFrame(id, { revision: 2, at }), err => {
      assert.equal(err.code, 'INVALID_ARGUMENTS', `at ${at} must be INVALID_ARGUMENTS, got ${err.code}: ${err.message}`);
      assert.match(err.message, /^at: a timeline time inside the edit \(0–20 s\)\.$/, `the message must name the range: ${err.message}`);
      return true;
    });
    const project = await getProject(id);
    assert.equal(project.revision, 2, `at ${at}: a refused freeze must not save a revision`);
    assert.equal(project.sources.length, 1, `at ${at}: a refused freeze must not add a still source`);
    assert.deepEqual(await stills(dir), [], `at ${at}: a refused freeze must not leave a freeze image behind`);
  }
});

test('a freeze inside the edit still adds the still frame', async t => {
  let tools;
  try { tools = findFfmpegTools(); } catch { return t.skip('FFmpeg not available'); }
  const file = path.join(root, 'clip.mp4');
  await runProcess(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi',
    '-i', 'testsrc=size=320x180:rate=25:duration=20', '-pix_fmt', 'yuv420p', file]);
  const { id, dir } = await seed(file);
  const out = await freezeFrame(id, { revision: 2, at: 19.5 });
  assert.equal(out.project.revision, 3, 'the freeze frame is saved as the next revision');
  assert.equal((await getProject(id)).sources.length, 2, 'the still is added as a source');
  assert.equal((await stills(dir)).length, 1, 'the grabbed frame stays in the project folder');
});
