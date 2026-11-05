import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { agentTools, runStudioCommand } from '../src/agent-tools.mjs';
import { parseArguments } from '../cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('help lists every studio tool', () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), 'help'], {
    encoding: 'utf8',
    env: { ...process.env, GAME_TRAILER_STUDIO_DATA_ROOT: path.join(ROOT, '.studio-data', 'cli-test') },
  });
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.split('\n').find(item => item.startsWith('Agent/editor interface:'));
  assert.ok(line, 'help must print the studio interface line');
  const listed = line.slice(line.indexOf('studio ') + 'studio '.length).split(' ')[0].split('|');
  for (const { name } of agentTools) {
    assert.ok(listed.includes(name.replace(/^studio_/, '')), `${name} is missing from help`);
  }
});

test('parseArguments keeps everything after the first = in a flag value', () => {
  const { flags, positional } = parseArguments([
    '--title=Score=100',
    '--query=a=b=c',
    '--x', 'v',
    '--y=z',
    '--no-cache',
    '--empty=',
    'tail',
  ]);
  assert.equal(flags.title, 'Score=100');
  assert.equal(flags.query, 'a=b=c');
  assert.equal(flags.x, 'v');
  assert.equal(flags.y, 'z');
  assert.equal(flags.cache, false);
  assert.equal(flags.empty, '');
  assert.deepEqual(positional, ['tail']);
});

const okApi = async route => (route === '/health'
  ? { service: 'AI Edit Studio', version: '0.11.0' }
  : { project: { id: '00000000-0000-0000-0000-000000000001', revision: 1 } });

async function requestFile(t, body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aes-request-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'request.json');
  await fs.writeFile(file, body);
  return file;
}

test('a request file that is not a JSON object is refused with INVALID_JSON', async t => {
  for (const body of ['null', '[1, 2]', '"text"', '42']) {
    const request = await requestFile(t, body);
    for (const flags of [{ request }, { request, project: 'abc' }]) {
      await assert.rejects(
        runStudioCommand('get', flags, okApi),
        error => error.code === 'INVALID_JSON' && /Request must be a JSON object\./.test(error.message),
        `${body} must answer INVALID_JSON`,
      );
    }
  }
});

test('a request file holding an object still reaches the tool', async t => {
  const request = await requestFile(t, '{"projectId": "00000000-0000-0000-0000-000000000001"}');
  const calls = [];
  const api = async (route, req) => { calls.push(route); return okApi(route, req); };
  await runStudioCommand('get', { request }, api);
  assert.deepEqual(calls, ['/health', '/studio/projects/00000000-0000-0000-0000-000000000001']);
});
