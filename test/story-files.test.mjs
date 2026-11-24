// A story names files; the dry run used to answer "ok" for a file that is not there, and the build failed only
// after the generated scenes in front of it had been rendered (#106). Both paths check the files the same way now.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aes-story-files-'));
process.env.GAME_TRAILER_STUDIO_DATA_ROOT = root;
const { storyApply } = await import('../src/studio.mjs');
const { findFfmpegTools } = await import('../src/ffmpeg.mjs');

const story = (over = {}) => ({ version: 'aes.story/1', size: '720', music: { bpm: 120 }, scenes: [{ id: 'a', kind: 'title', beats: 4, lines: ['Hello'] }], ...over });
const footage = (extra = {}) => ({ id: 'clip', source: '/nonexistent/nope.mp4', start: 0, beats: 4, ...extra });

test('the dry run fails for a missing footage file, like the build (#106)', async () => {
  const s = story({ scenes: [{ id: 'hook', kind: 'title', beats: 4, lines: ['Hello'] }, footage()] });
  await assert.rejects(() => storyApply({ story: s, dryRun: true }), e => e.code === 'FILE_NOT_FOUND' && /nope\.mp4/.test(e.message),
    'a dry run names the missing footage file instead of saying ok');
  await assert.rejects(() => storyApply({ story: s }), e => e.code === 'FILE_NOT_FOUND' && /nope\.mp4/.test(e.message),
    'the build checks the same file before it renders the scene in front of it');
});

test('the dry run fails for a missing music file (#106)', async () => {
  const s = story({ music: { bpm: 120, file: '/nonexistent/theme.mp3' } });
  await assert.rejects(() => storyApply({ story: s, dryRun: true }), e => e.code === 'FILE_NOT_FOUND' && /theme\.mp3/.test(e.message));
});

test('the dry run fails when a source range runs past the end of the clip (#106)', async t => {
  let tools;
  try { tools = findFfmpegTools(); } catch { return t.skip('FFmpeg not available'); }
  const clip = path.join(root, 'one-second.mp4');
  const { spawnSync } = await import('node:child_process');
  const made = spawnSync(tools.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30', '-t', '1', '-pix_fmt', 'yuv420p', clip], { encoding: 'utf8' });
  if (made.status !== 0) return t.skip(`FFmpeg could not make the clip: ${made.stderr}`);

  const s = story({ scenes: [footage({ source: clip, start: 5 })] });
  await assert.rejects(() => storyApply({ story: s, dryRun: true }),
    e => e.code === 'INVALID_STORY' && /is 1 s long; the scene needs source time up to 7 s/.test(e.message),
    'the dry run checks the source range against the real clip length');

  const inside = story({ scenes: [footage({ source: clip, start: 0, beats: 2 })] });
  const ok = await storyApply({ story: inside, dryRun: true });
  assert.equal(ok.dryRun, true, 'a range inside the clip still passes');
});
