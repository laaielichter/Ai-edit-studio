// An old shot id after a split or a new proposal must not be silently ignored
// (#135): reframe, auto_zoom, color_match and stabilize all answer CLIP_NOT_FOUND.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-edit-clip-ids-'));
process.env.GAME_TRAILER_STUDIO_DATA_ROOT = root;
const { reframeProject, autoZoomProject, colorMatchProject, stabilizeProject, assertKnownClips } = await import('../src/studio.mjs');
const { validateClips } = await import('../src/editing.mjs');

// A real file so validateSourceState() passes and the checks under test are reached.
const media = path.join(root, 'a.mp4');
await fs.writeFile(media, 'placeholder');
const stat = await fs.stat(media);
const sources = [{ name: 'a.mp4', file: media, duration: 20, size: stat.size, mtimeMs: stat.mtimeMs,
  hasAudio: true, audio: [], black: [], motion: [], scenes: [], video: { width: 1920, height: 1080 } }];
const shots = [{ id: 'a', sourceIndex: 0, start: 0, end: 10 }, { id: 'b', sourceIndex: 0, start: 10, end: 20 }];

async function seed(id) {
  const dir = path.join(root, 'studio', 'projects', id);
  await fs.mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify({
    schemaVersion: 2, id, revision: 2, name: 'Clip ids', options: {}, sources,
    plan: { ...validateClips(shots, sources), style: 'flight' },
    status: 'draft', progress: 0, message: 'Analyzed.', warnings: [], exports: [], createdAt: now, updatedAt: now,
  }));
}

const clipNotFound = (e) => e.code === 'CLIP_NOT_FOUND' && /typo123/.test(e.message);

test('assertKnownClips: unknown id is refused, known ids and "all" are accepted (#135)', () => {
  const project = { plan: { clips: shots } };
  assert.throws(() => assertKnownClips(project, ['typo123']),
    (e) => e.code === 'CLIP_NOT_FOUND' && /Clip id typo123 does not exist \(anymore\)\./.test(e.message));
  assert.throws(() => assertKnownClips(project, ['a', 'typo123']), clipNotFound, 'an unknown id in a mixed list is still refused');
  for (const refs of [['a', 'b'], ['a'], [], 'all', undefined, null]) {
    assert.doesNotThrow(() => assertKnownClips(project, refs), `refs=${JSON.stringify(refs)} is accepted`);
  }
});

test('reframe, auto_zoom and color_match refuse an unknown clip id, also with dryRun (#135)', async () => {
  const tools = [
    ['reframeProject', '3101', (id) => reframeProject(id, { revision: 2, clips: ['typo123'], dryRun: true })],
    ['autoZoomProject', '3102', (id) => autoZoomProject(id, { revision: 2, style: 'push', clips: ['typo123'], dryRun: true })],
    ['colorMatchProject', '3103', (id) => colorMatchProject(id, { revision: 2, clips: ['typo123'], dryRun: true })],
  ];
  for (const [name, suffix, call] of tools) {
    const id = `22222222-2222-4222-8222-22222222${suffix}`;
    await seed(id);
    await assert.rejects(call(id), clipNotFound, `${name}: CLIP_NOT_FOUND naming typo123, not a misleading ok`);
  }
});

test('stabilize keeps its CLIP_NOT_FOUND answer for the same id (#135)', async () => {
  const id = '22222222-2222-4222-8222-222222223104';
  await seed(id);
  await assert.rejects(stabilizeProject(id, { revision: 2, clips: ['typo123'], dryRun: true }), clipNotFound);
});

test('clips: "all", omitted and existing ids do not raise CLIP_NOT_FOUND (#135)', async () => {
  const id = '22222222-2222-4222-8222-222222223105';
  await seed(id);
  for (const clips of ['all', undefined, ['a', 'b']]) {
    try {
      await colorMatchProject(id, { revision: 2, clips, dryRun: true });
    } catch (e) {
      // The real work needs FFmpeg and may fail on this machine; the point is
      // that the id check itself does not reject a valid selection.
      assert.notEqual(e.code, 'CLIP_NOT_FOUND', `clips=${JSON.stringify(clips)}: got ${e.code}`);
    }
  }
});
