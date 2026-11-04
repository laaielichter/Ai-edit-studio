// probeMedia/probeStill/probeAudio name the file when ffprobe cannot read it (#11).
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-edit-probe-'));
process.env.GAME_TRAILER_STUDIO_DATA_ROOT = root;

const { probeMedia, probeStill, probeAudio, findFfmpegTools } = await import('../src/ffmpeg.mjs');
const tools = (() => { try { return findFfmpegTools(); } catch { return {}; } })();
const hasFfmpeg = Boolean(tools.ffmpeg && tools.ffprobe);

test('probeMedia: damaged file gives UNSUPPORTED_MEDIA naming the file', {
  skip: !hasFfmpeg ? 'FFmpeg not installed' : false,
  timeout: 30_000,
}, async () => {
  const file = path.join(root, 'broken.mp4');
  await fs.writeFile(file, 'this is not a video');
  await assert.rejects(
    () => probeMedia(file, tools),
    err => {
      assert.equal(err.code, 'UNSUPPORTED_MEDIA');
      assert.ok(err.message.includes('broken.mp4'), `message should name broken.mp4: ${err.message}`);
      return true;
    },
  );
});

test('probeStill: damaged image gives UNSUPPORTED_MEDIA naming the file', {
  skip: !hasFfmpeg ? 'FFmpeg not installed' : false,
  timeout: 30_000,
}, async () => {
  const file = path.join(root, 'broken.png');
  await fs.writeFile(file, 'not an image');
  await assert.rejects(
    () => probeStill(file, tools),
    err => {
      assert.equal(err.code, 'UNSUPPORTED_MEDIA');
      assert.ok(err.message.includes('broken.png'), `message should name broken.png: ${err.message}`);
      return true;
    },
  );
});

test('probeAudio: damaged audio gives UNSUPPORTED_MEDIA naming the file', {
  skip: !hasFfmpeg ? 'FFmpeg not installed' : false,
  timeout: 30_000,
}, async () => {
  const file = path.join(root, 'broken.wav');
  await fs.writeFile(file, 'not audio');
  await assert.rejects(
    () => probeAudio(file, tools),
    err => {
      assert.equal(err.code, 'UNSUPPORTED_MEDIA');
      assert.ok(err.message.includes('broken.wav'), `message should name broken.wav: ${err.message}`);
      return true;
    },
  );
});
