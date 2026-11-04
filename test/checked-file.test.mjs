// checkedFile names the offending path and says which check failed (#9).
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-edit-checked-file-'));
process.env.GAME_TRAILER_STUDIO_DATA_ROOT = root;
const { checkedFile } = await import('../src/studio.mjs');

const EXTS = ['.mp4', '.mov'];

test('missing path: FILE_NOT_FOUND names the path', async () => {
  const missing = path.join(root, 'does-not-exist.mp4');
  await assert.rejects(
    () => checkedFile(missing, EXTS),
    err => {
      assert.equal(err.code, 'FILE_NOT_FOUND');
      assert.ok(err.message.includes(missing), `message should name ${missing}: ${err.message}`);
      return true;
    },
  );
});

test('wrong extension: INVALID_MEDIA names the file and lists allowed extensions', async () => {
  const file = path.join(root, 'notes.txt');
  await fs.writeFile(file, 'hello');
  await assert.rejects(
    () => checkedFile(file, EXTS),
    err => {
      assert.equal(err.code, 'INVALID_MEDIA');
      assert.ok(err.message.includes(file), 'message should name the file');
      assert.ok(err.message.includes('.txt'), 'message should name the bad extension');
      assert.ok(err.message.includes('.mp4') && err.message.includes('.mov'), 'message should list allowed extensions');
      return true;
    },
  );
});

test('file over the limit: INVALID_MEDIA names the file and the limit', async () => {
  const file = path.join(root, 'big.mp4');
  await fs.writeFile(file, Buffer.alloc(64));
  await assert.rejects(
    () => checkedFile(file, EXTS, 32),
    err => {
      assert.equal(err.code, 'INVALID_MEDIA');
      assert.ok(err.message.includes(file), 'message should name the file');
      assert.ok(/limit/i.test(err.message), 'message should mention the limit');
      return true;
    },
  );
});

test('a directory: INVALID_MEDIA says it is not a regular file', async () => {
  const dir = path.join(root, 'a-folder.mp4');
  await fs.mkdir(dir);
  await assert.rejects(
    () => checkedFile(dir, EXTS),
    err => {
      assert.equal(err.code, 'INVALID_MEDIA');
      assert.ok(err.message.includes(dir), 'message should name the path');
      assert.ok(/regular file/i.test(err.message), 'message should say it is not a regular file');
      return true;
    },
  );
});

test('a valid file passes through', async () => {
  const file = path.join(root, 'ok.mp4');
  await fs.writeFile(file, Buffer.alloc(16));
  const result = await checkedFile(file, EXTS, 1024);
  assert.equal(result.size, 16);
});