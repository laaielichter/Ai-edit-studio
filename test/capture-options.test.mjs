// A capture used to replace any fps it did not support with 60, silently (#173).
// Validate before anything is started; no Windows/game/FFmpeg is needed here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-edit-capture-fps-'));
process.env.GAME_TRAILER_STUDIO_DATA_ROOT = root;
const { captureFps, CAPTURE_FPS, CaptureManager } = await import('../src/capture.mjs');
const { captureStartRequest } = await import('../cli.mjs');

const start = (fps) => new CaptureManager().start({ process: 'game.exe', fps });

test('an omitted fps still means 60, and the three supported rates pass through', () => {
  assert.deepEqual(CAPTURE_FPS, [30, 60, 120]);
  for (const [given, expected] of [
    [undefined, 60], [null, 60], ['', 60],
    [30, 30], [60, 60], [120, 120],
    ['30', 30], ['60', 60], ['120', 120], // the HTTP API sends strings
  ]) assert.equal(captureFps(given), expected, `captureFps(${JSON.stringify(given)})`);
});

test('every other value is refused with INVALID_FPS and names what was typed', () => {
  for (const bad of [144, 0, 29, 48, 30.5, -1, 'abc', NaN, Infinity, true, {}, []]) {
    assert.throws(() => captureFps(bad), error =>
      error.code === 'INVALID_FPS'
      && /fps must be 30, 60 or 120 for a capture/.test(error.message)
      && error.message.includes(`got ${String(bad)}.`),
    `captureFps(${JSON.stringify(bad)}) must be refused`);
  }
});

test('a bad fps cannot start a recording or write any state', async () => {
  const manager = new CaptureManager();
  await assert.rejects(() => manager.start({ process: 'game.exe', fps: 144 }), error =>
    error.code === 'INVALID_FPS' && /got 144/.test(error.message));
  assert.equal(manager.session, null);
  assert.equal(manager.state.state, 'idle');
  assert.equal(manager.state.sessionId, null);
  assert.equal(existsSync(path.join(root, 'capture-state.json')), false, 'nothing was persisted');
});

test('the fps check comes before the busy check, so it cannot hide behind CAPTURE_BUSY', async () => {
  const bad = new CaptureManager();
  bad.state.state = 'recording';
  await assert.rejects(() => bad.start({ process: 'game.exe', fps: 0 }), error => error.code === 'INVALID_FPS');
  const good = new CaptureManager();
  good.state.state = 'recording';
  await assert.rejects(() => good.start({ process: 'game.exe', fps: 30 }), error => error.code === 'CAPTURE_BUSY',
    'a valid rate gets past validation to the next check');
});

test('the CLI passes the raw --fps value instead of coercing it to 60 or NaN', () => {
  assert.deepEqual(captureStartRequest({ process: 'game.exe' }),
    { process: 'game.exe', project: 'Game capture', audioDevice: '' }, 'omitted fps stays omitted');
  assert.equal(captureStartRequest({ process: 'game.exe', fps: '144' }).fps, '144');
  assert.equal(captureStartRequest({ process: 'game.exe', fps: 'abc' }).fps, 'abc');
  assert.equal(captureStartRequest({ process: 'game.exe', fps: 120 }).fps, 120);
  assert.equal(captureStartRequest({ process: 'bf6.exe', project: 'BF6', fps: 120, 'audio-device': 'mic' }).project, 'BF6');
});
