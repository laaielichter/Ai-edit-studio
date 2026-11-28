import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { agentTools, runStudioCommand } from '../src/agent-tools.mjs';
import { checkSetupFlags, parseArguments, validatePort } from '../cli.mjs';

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

test('version aliases print only the installed package version', async () => {
  const { name, version } = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  for (const alias of ['--version', '-v', 'version']) {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), alias], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || alias);
    assert.equal(result.stdout, name + ' ' + version + '\n', alias);
    assert.equal(result.stderr, '', alias);
  }
});

test('-h prints the same top-level help as --help', () => {
  const run = alias => spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), alias], { encoding: 'utf8' });
  const help = run('--help');
  const short = run('-h');
  assert.equal(help.status, 0, help.stderr);
  assert.equal(short.status, 0, short.stderr);
  assert.equal(short.stdout, help.stdout);
  assert.equal(short.stderr, '');
});

test('studio help aliases print the same tool list as studio --help', () => {
  const run = args => spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), ...args], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GAME_TRAILER_STUDIO_DATA_ROOT: path.join(ROOT, '.studio-data', 'cli-test') },
  });
  const expected = run(['studio', '--help']);
  assert.equal(expected.status, 0, expected.stderr);
  assert.equal(expected.stderr, '');
  for (const args of [['studio'], ['studio', '-h'], ['studio', 'help'], ['studio', 'help', '--help']]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr || args.join(' '));
    assert.equal(result.stdout, expected.stdout, args.join(' '));
    assert.equal(result.stderr, '', args.join(' '));
  }
});

test('unknown studio tool names remain errors', () => {
  for (const args of [['studio', 'nope'], ['studio', 'nope', '--help']]) {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), ...args], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
      env: { ...process.env, GAME_TRAILER_STUDIO_DATA_ROOT: path.join(ROOT, '.studio-data', 'cli-test') },
    });
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, 'UNKNOWN_TOOL');
  }
});

test('unknown studio tool names fail before calling the API', async () => {
  let calls = 0;
  const api = async () => { calls += 1; throw new Error('API must not be called'); };
  await assert.rejects(runStudioCommand('nope', {}, api), error => error.code === 'UNKNOWN_TOOL');
  assert.equal(calls, 0);
});

test('studio get keeps the existing API dispatch', async () => {
  const id = '00000000-0000-0000-0000-000000000001';
  const calls = [];
  const api = async (route, request) => {
    calls.push({ route, request });
    if (route === '/health') return { service: 'AI Edit Studio', version: '0.12.0' };
    assert.equal(route, `/studio/projects/${id}`);
    assert.equal(request, undefined);
    return { project: { id, revision: 1 } };
  };
  const result = await runStudioCommand('get', { project: id }, api);
  assert.deepEqual(calls.map(call => call.route), ['/health', `/studio/projects/${id}`]);
  assert.deepEqual(result, { project: { id, revision: 1 } });
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

test('a missing or directory request file is refused with a studio error code', async t => {
  const missing = path.join(os.tmpdir(), 'aes-request-missing-12345.json');
  await assert.rejects(
    runStudioCommand('get', { request: missing }, okApi),
    error => error.code === 'FILE_NOT_FOUND' && error.message === `File not found: ${missing}`,
    'a missing request file must answer FILE_NOT_FOUND',
  );
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aes-request-dir-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    runStudioCommand('get', { request: dir }, okApi),
    error => error.code === 'INVALID_ARGUMENTS' && error.message === `--request must be a file, got a folder: ${dir}`,
    'a directory request path must answer INVALID_ARGUMENTS',
  );
});

test('a request file holding an object still reaches the tool', async t => {
  const request = await requestFile(t, '{"projectId": "00000000-0000-0000-0000-000000000001"}');
  const calls = [];
  const api = async (route, req) => { calls.push(route); return okApi(route, req); };
  await runStudioCommand('get', { request }, api);
  assert.deepEqual(calls, ['/health', '/studio/projects/00000000-0000-0000-0000-000000000001']);
});

const ID = '00000000-0000-0000-0000-000000000001';

function capture() {
  const calls = [];
  const api = async (route, req) => { calls.push({ route, body: req?.body }); return okApi(route, req); };
  return { calls, api };
}

test('studio <tool> --help prints the flags of that tool', () => {
  const env = { ...process.env, GAME_TRAILER_STUDIO_DATA_ROOT: path.join(ROOT, '.studio-data', 'cli-test') };
  const run = args => spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), ...args], { encoding: 'utf8', env });
  const edit = run(['studio', 'edit', '--help']);
  assert.equal(edit.status, 0, edit.stderr);
  assert.match(edit.stdout, /studio_edit/);
  assert.match(edit.stdout, /--revision/);
  assert.match(edit.stdout, /--operations/);
  assert.match(edit.stdout, /--project-id[^\n]*required/);
  const unknown = run(['studio', 'nope', '--help']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /UNKNOWN_TOOL/);
});

test('studio wait and qc take their arguments as flags', async () => {
  const { calls, api } = capture();
  await runStudioCommand('wait', { project: ID, until: 'idle', 'timeout-seconds': '30' }, api);
  assert.equal(calls.at(-1).route, `/studio/projects/${ID}/wait`);
  assert.deepEqual(calls.at(-1).body, { until: 'idle', timeoutSeconds: 30 });
  await runStudioCommand('qc', { 'project-id': ID, 'export-id': ID }, api);
  assert.equal(calls.at(-1).route, `/studio/projects/${ID}/qc`);
  assert.deepEqual(calls.at(-1).body, { exportId: ID });
});

test('flags override the request file, including --no-<flag> for booleans', async t => {
  const request = await requestFile(t, JSON.stringify({ projectId: ID, revision: 1, preview: true, formats: ['hd'] }));
  const { calls, api } = capture();
  await runStudioCommand('render', { request, preview: false }, api);
  assert.deepEqual(calls.at(-1).body, { revision: 1, preview: false, formats: ['hd'] });
});

test('the flags that worked before still produce the same arguments', async () => {
  const { calls, api } = capture();
  await runStudioCommand('render', { project: ID, revision: '3', formats: 'landscape,vertical', preview: true }, api);
  assert.equal(calls.at(-1).route, `/studio/projects/${ID}/export`);
  assert.deepEqual(calls.at(-1).body, { revision: 3, formats: ['landscape', 'vertical'], preview: true });
});

test('bad flags fail with a clear error before reaching the tool', async () => {
  await assert.rejects(
    runStudioCommand('qc', { project: ID, 'nope-flag': '1' }, okApi),
    error => error.code === 'UNKNOWN_FLAG' && /--nope-flag/.test(error.message) && /--export-id/.test(error.message),
  );
  await assert.rejects(
    runStudioCommand('wait', { project: ID, 'timeout-seconds': 'soon' }, okApi),
    error => error.code === 'INVALID_ARGUMENTS' && /--timeout-seconds/.test(error.message),
  );
  await assert.rejects(
    runStudioCommand('edit', { project: ID, revision: '1', operations: 'not json' }, okApi),
    error => error.code === 'INVALID_ARGUMENTS' && /not valid JSON/.test(error.message),
  );
});

test('a bad GAME_TRAILER_STUDIO_PORT is INVALID_PORT before a server is started (#133)', () => {
  const dataRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ai-edit-port-'));
  const base = { ...process.env, GAME_TRAILER_STUDIO_DATA_ROOT: dataRoot };
  for (const bad of ['abc', '99999']) {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), 'jobs'], {
      encoding: 'utf8', env: { ...base, GAME_TRAILER_STUDIO_PORT: bad }, timeout: 20_000,
    });
    assert.equal(result.status, 1, `exit code for ${bad}: ${result.stderr}`);
    const record = JSON.parse(result.stderr);
    assert.equal(record.ok, false);
    assert.equal(record.error.code, 'INVALID_PORT', `code for ${bad}: ${result.stderr}`);
    assert.match(record.error.message, new RegExp(`Invalid local server port: ${bad}`));
    assert.match(record.error.message, /GAME_TRAILER_STUDIO_PORT/);
    assert.match(record.error.message, /1 to 65535/);
    assert.doesNotMatch(result.stderr, /SERVER_START_FAILED/, 'must not point at server.log');
  }
  assert.equal(fsSync.existsSync(path.join(dataRoot, 'logs', 'server.log')), false,
    'no server.log means no daemon was spawned and no log dir was created');
  // A valid port and the default are still accepted; only bad values are refused.
  assert.equal(validatePort('32146'), 32146);
  assert.equal(validatePort(1), 1);
  assert.equal(validatePort('65535'), 65535);
  for (const bad of ['abc', '0', '65536', '-1', '12.5', '']) {
    assert.throws(() => validatePort(bad), error => error.code === 'INVALID_PORT'
      && /GAME_TRAILER_STUDIO_PORT/.test(error.message), `refused ${JSON.stringify(bad)}`);
  }
});

test('hyphen and mixed-case tool names reach the same tool (#101)', async () => {
  for (const name of ['auto-edit', 'Auto_Edit', 'auto_edit']) {
    await assert.rejects(
      runStudioCommand(name, {}, okApi),
      err => err.code === 'INVALID_ARGUMENTS',
    );
  }
});

test('an unknown tool lists the tools and suggests a close name (#101)', async () => {
  await assert.rejects(
    runStudioCommand('auto-edt', {}, okApi),
    err => err.code === 'UNKNOWN_TOOL'
      && /Did you mean auto_edit\?/.test(err.message)
      && /Tools: /.test(err.message),
  );
});

test('install, uninstall and codex-setup refuse a mistyped option before writing anything (#170)', t => {
  const home = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ai-edit-setup-flags-'));
  const empty = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ai-edit-setup-path-'));
  t.after(() => Promise.all([home, empty].map(dir => fs.rm(dir, { recursive: true, force: true }))));
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: path.join(home, '.config'), CODEX_HOME: path.join(home, '.codex'), PATH: empty, Path: empty,
    GAME_TRAILER_STUDIO_DATA_ROOT: path.join(home, 'data'), AI_EDIT_STUDIO_HOME: '',
  };
  const cases = [
    [['install', '--dryrun'], 'UNKNOWN_FLAG', /--dryrun is not an option of install/],
    [['install', '--no-claud'], 'UNKNOWN_FLAG', /--no-claud is not an option of install/],
    [['install', '--data-root'], 'INVALID_DATA_ROOT', /--data-root needs a folder/],
    [['install', '--data-root', '--dry-run'], 'INVALID_DATA_ROOT', /--data-root needs a folder/],
    [['install', '--data-root='], 'INVALID_DATA_ROOT', /--data-root needs a folder/],
    [['uninstall', '--no-cursr'], 'UNKNOWN_FLAG', /--no-cursr is not an option of uninstall/],
    [['codex-setup', '--plugn'], 'UNKNOWN_FLAG', /--plugn is not an option of codex-setup/],
    [['codex-setup', '--data-root'], 'INVALID_DATA_ROOT', /--data-root needs a folder/],
  ];
  for (const [args, code, message] of cases) {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), ...args], {
      cwd: home, encoding: 'utf8', env, timeout: 20_000,
    });
    assert.equal(result.status, 1, `exit code for ${args.join(' ')}: ${result.stdout}${result.stderr}`);
    const record = JSON.parse(result.stderr);
    assert.equal(record.error.code, code, args.join(' '));
    assert.match(record.error.message, message, args.join(' '));
    assert.match(record.error.message, /nothing was changed/i, args.join(' '));
    assert.equal(result.stdout, '', args.join(' '));
    assert.deepEqual(fsSync.readdirSync(home), [], `${args.join(' ')} must not write any file`);
  }
});

test('the documented setup options are still accepted (#170)', () => {
  for (const command of ['install', 'uninstall']) {
    assert.doesNotThrow(() => checkSetupFlags(command, {
      'data-root': '/tmp/ai-edit', claude: false, codex: false, desktop: false, cursor: false, 'dry-run': true, json: true,
    }));
  }
  assert.doesNotThrow(() => checkSetupFlags('codex-setup', { 'data-root': '/tmp/ai-edit', plugin: true, uninstall: true, 'dry-run': true }));
  assert.doesNotThrow(() => checkSetupFlags('install', {}));
  assert.doesNotThrow(() => checkSetupFlags('jobs', { anything: true }), 'other commands are unchanged');
  assert.throws(() => checkSetupFlags('install', { 'data-root': false }), error => error.code === 'INVALID_DATA_ROOT');
  assert.throws(() => checkSetupFlags('codex-setup', { 'no-claude': true }), error => error.code === 'UNKNOWN_FLAG'
    && /--data-root <folder>, --plugin, --uninstall, --dry-run/.test(error.message));
});
