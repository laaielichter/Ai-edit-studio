// Regression: the pre-mixed sound-effect track must end with the edit. With one effect used more than once
// (asplit) the old "apad,atrim=duration" never ended and wrote silence until the disk was full.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-edit-sfx-'));
process.env.GAME_TRAILER_STUDIO_DATA_ROOT = root;
const { buildSfxTrack } = await import('../src/render.mjs');
const { findFfmpegTools, supportsFileOptions, filterComplexFile } = await import('../src/ffmpeg.mjs');
const tools = (() => { try { return findFfmpegTools(); } catch { return {}; } })();

test('sound-effect track lasts exactly as long as the edit, with effects used several times', { skip: !tools.ffmpeg || !tools.ffprobe ? 'FFmpeg not installed' : false, timeout: 60_000 }, async () => {
  try {
    const tmp = await fs.mkdtemp(path.join(root, 'job-'));
    const sfx = [{ time: 0.1, kind: 'pop', gain: 0.5 }, { time: 1.2, kind: 'pop', gain: 0.5 }, { time: 2.4, kind: 'pop', gain: 0.5 },
      { time: 0.6, kind: 'whoosh', gain: 0.5 }, { time: 2.9, kind: 'whoosh', gain: 0.5 }, { time: 3.5, kind: 'hit', gain: 0.5 }];
    const out = await buildSfxTrack(sfx, 4.25, tmp, tools).catch(e => {
      const version = spawnSync(tools.ffmpeg, ['-version'], { encoding: 'utf8' }).stdout.split('\n')[0];
      throw new Error(`${e.message} ${version}: ${String(e.details?.stderr ?? '').trim().slice(-600)}`);
    });
    const probe = spawnSync(tools.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' });
    assert.ok(Math.abs(Number(probe.stdout.trim()) - 4.25) < 0.01, `duration ${probe.stdout.trim()}`);
    assert.ok((await fs.stat(out)).size < 4.25 * 48000 * 4 + 4096);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('filter graphs load from a file with the option this FFmpeg build understands', () => {
  assert.equal(supportsFileOptions('ffmpeg version 9.0.2-essentials_build-www.gyan.dev Copyright'), true);
  assert.equal(supportsFileOptions('ffmpeg version n7.1 Copyright'), true);
  assert.equal(supportsFileOptions('ffmpeg version 6.1.1-3ubuntu5 Copyright'), false);
  assert.equal(supportsFileOptions('ffmpeg version N-118000-g1234abcd Copyright'), true, 'git builds are new');
  if (tools.ffmpeg) assert.equal(filterComplexFile('g.txt', tools.ffmpeg).at(-1), 'g.txt');
});
