// Brand kit ids fold accents, and kits saved under the old id stay readable (#22).
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-edit-brand-'));
process.env.GAME_TRAILER_STUDIO_DATA_ROOT = root;
const { normalizeBrand, saveBrand, getBrand } = await import('../src/brand.mjs');

test('an accented name keeps a readable id', async () => {
  assert.equal((await normalizeBrand({ name: 'Café Noir' })).id, 'cafe-noir');
  assert.equal((await normalizeBrand({ name: 'Zoë' })).id, 'zoe');
});

test('a name with no Latin letters is refused with a reason', async () => {
  await assert.rejects(
    () => normalizeBrand({ name: 'ブランド' }),
    error => error.code === 'INVALID_BRAND' && /at least one Latin letter or digit/.test(error.message),
    'a non-Latin name must say why it was refused',
  );
  await assert.rejects(
    () => normalizeBrand({}),
    error => error.code === 'INVALID_BRAND' && /Give the brand kit a name/.test(error.message),
    'an empty name keeps the old message',
  );
});

test('a kit saved under the old id is still found', async () => {
  const dir = path.join(root, 'studio', 'brands');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'caf-noir.json'), JSON.stringify({ schemaVersion: 1, id: 'caf-noir', name: 'Café Noir' }));

  assert.equal((await getBrand('Café Noir')).id, 'caf-noir', 'the pre-fold file must still be read');

  const saved = await saveBrand({ name: 'Café Noir' });
  assert.equal(saved.id, 'cafe-noir');
  assert.equal((await getBrand('Café Noir')).id, 'cafe-noir', 'the new id wins once the kit is saved again');
});
