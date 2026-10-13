import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { install, mergeMcpJson, formatReport, findOnPath } = await import('../src/install.mjs');
const { ffmpegInstallHint } = await import('../src/ffmpeg.mjs');
const { userSettingsFile } = await import('../src/settings.mjs');
const { pluginEnv } = await import('../plugin/mcp-launch.mjs');
const { buildRelease, releaseFileList, zip, unzip: readZip } = await import('../tools/build-release.mjs');

const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'aes-install-'));

test('settings file location per platform', () => {
  assert.equal(userSettingsFile({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32', 'C:\\Users\\a'), path.join('C:\\Users\\a\\AppData\\Roaming', 'AI Edit Studio', 'settings.json'));
  assert.equal(userSettingsFile({}, 'darwin', '/Users/a'), path.join('/Users/a', '.config', 'ai-edit-studio', 'settings.json'));
  assert.deepEqual(pluginEnv({}, 'linux', '/home/a', { dataRoot: '/videos' }), {}, 'installer choice wins over the plugin default');
});

test('MCP JSON merge keeps other servers and refuses broken files', () => {
  const merged = JSON.parse(mergeMcpJson('{"theme":"dark","mcpServers":{"other":{"command":"x"}}}', { command: 'node', args: ['l.mjs'] }));
  assert.deepEqual(Object.keys(merged.mcpServers), ['other', 'ai-edit-studio']);
  assert.equal(merged.theme, 'dark');
  assert.deepEqual(JSON.parse(mergeMcpJson(JSON.stringify(merged), null)).mcpServers, { other: { command: 'x' } });
  assert.throws(() => mergeMcpJson('{broken', { command: 'node' }), { code: 'INVALID_CLIENT_CONFIG' });
});

test('installer connects every client it finds, is repeatable and uninstalls', async () => {
  const home = await temp();
  const env = { XDG_CONFIG_HOME: path.join(home, '.config'), CODEX_HOME: path.join(home, '.codex') };
  await fs.mkdir(path.join(home, '.cursor'), { recursive: true });
  await fs.mkdir(env.CODEX_HOME, { recursive: true });
  const runs = [];
  const base = { env, home, platform: 'linux', node: '/usr/bin/node', ffmpegCheck: () => ({ status: 'done', detail: '/usr/bin/ffmpeg' }), which: n => (n === 'claude' ? '/bin/claude' : null), run: (f, a) => { runs.push(a.join(' ')); return { ok: true, output: '' }; } };

  const dry = await install({ ...base, dryRun: true });
  assert.ok(dry.steps.every(s => s.status !== 'done' || /FFmpeg|OpenAI API/.test(s.step)));
  await assert.rejects(fs.access(path.join(home, 'AI-Edit-Studio')), 'dry run writes nothing');

  const first = await install(base);
  assert.equal(first.ok, true, formatReport(first));
  const byStep = Object.fromEntries(first.steps.map(s => [s.step, s.status]));
  assert.deepEqual(byStep, { 'Data folder': 'done', FFmpeg: 'done', 'Claude Code': 'done', 'OpenAI Codex': 'done', 'Claude Desktop': 'skipped', Cursor: 'done', 'OpenAI API / Agents SDK': 'done' });
  assert.ok(runs.some(r => r.startsWith('plugin marketplace add ')));
  assert.ok(runs.includes('plugin install ai-edit-studio@ai-edit-studio'));
  const settings = JSON.parse(await fs.readFile(userSettingsFile(env, 'linux', home), 'utf8'));
  assert.equal(settings.dataRoot, path.join(home, 'AI-Edit-Studio'));
  assert.match(await fs.readFile(path.join(env.CODEX_HOME, 'config.toml'), 'utf8'), /\[mcp_servers\.ai-edit-studio\]/);

  const again = await install(base);
  assert.equal(again.ok, true);
  assert.equal((await fs.readFile(path.join(env.CODEX_HOME, 'config.toml'), 'utf8')).match(/mcp_servers\.ai-edit-studio/g).length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers['ai-edit-studio'].command, '/usr/bin/node');

  const removed = await install({ ...base, uninstall: true });
  assert.equal(removed.ok, true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers, {});
  await assert.rejects(fs.access(userSettingsFile(env, 'linux', home)));
  await fs.access(path.join(home, 'AI-Edit-Studio')); // the person's projects are never removed
});

test('installer reports an unusable FFmpeg with the fix for the OS and requires a data folder on Windows', async () => {
  const home = await temp();
  const env = { APPDATA: path.join(home, 'Roaming'), CODEX_HOME: path.join(home, 'nocodex') };
  const base = { env, home, which: () => null, run: () => ({ ok: true }), clients: { desktop: false, cursor: false }, ffmpegCheck: () => ({ status: 'failed', detail: `not found — ${ffmpegInstallHint('linux')}` }) };
  await assert.rejects(install({ ...base, platform: 'win32' }), { code: 'DATA_ROOT_REQUIRED' });
  await assert.rejects(install({ ...base, platform: 'win32', dataRoot: 'relative\\folder' }), { code: 'INVALID_DATA_ROOT' });
  const report = await install({ ...base, platform: 'linux' });
  assert.equal(report.ok, false);
  assert.match(report.steps.find(s => s.step === 'FFmpeg').detail, /apt install ffmpeg/);
  assert.match(ffmpegInstallHint('darwin'), /brew install ffmpeg-full/, 'plain Homebrew ffmpeg cannot draw text');
  assert.match(ffmpegInstallHint('win32'), /winget install Gyan\.FFmpeg/);
  assert.equal(findOnPath('definitely-not-a-real-binary-aes'), null);
});


test('zip writer round-trips content and file modes', () => {
  const files = readZip(zip([{ name: 'a/x.txt', data: Buffer.from('hello hello hello hello') }, { name: 'a/run.sh', data: Buffer.from('#!/bin/sh\n'), mode: 0o755 }]));
  assert.equal(files.get('a/x.txt').data.toString(), 'hello hello hello hello');
  assert.equal(files.get('a/run.sh').mode & 0o777, 0o755);
});

test('release zip ships the runtime, installers and both plugins — not tests or internal plans', async () => {
  const list = await releaseFileList();
  for (const must of ['cli.mjs', 'INSTALL.md', 'SUPPORT.md', 'PRIVACY.md', 'Install-AI-Edit-Studio.cmd', 'install.sh', '.claude-plugin/plugin.json', 'plugins/ai-edit-studio/.codex-plugin/plugin.json', '.agents/plugins/marketplace.json', 'skills/viral-short/SKILL.md', 'examples/openai/openai-agent.mjs', 'src/install.mjs']) {
    assert.ok(list.includes(must), `missing ${must}`);
  }
  assert.ok(!list.some(f => /^(test|tools)\//.test(f)), 'internal files must not ship');
  const out = await temp();
  const result = await buildRelease({ outDir: out });
  const files = readZip(await fs.readFile(result.file));
  assert.equal(files.size, list.length);
  const top = path.basename(result.file, '.zip');
  assert.equal(files.get(`${top}/install.sh`).mode & 0o777, 0o755);
  assert.equal(files.get(`${top}/cli.mjs`).data.toString(), await fs.readFile('cli.mjs', 'utf8'));
  assert.match(await fs.readFile(`${result.file}.sha256`, 'utf8'), new RegExp(`^${result.sha256}  ${top}\\.zip`));
});

test('CLI entry points also start when reached through a symlink (macOS /var → /private/var)', async (t) => {
  const { isMainModule } = await import('../src/main-module.mjs');
  const dir = await temp();
  const real = path.join(dir, 'real.mjs');
  await fs.writeFile(real, '');
  const link = path.join(dir, 'link.mjs');
  try { await fs.symlink(real, link); } catch { t.skip('symlinks not allowed here'); return; }
  const url = pathToFileURL(real).href;
  assert.equal(isMainModule(url, link), true);
  assert.equal(isMainModule(url, real), true);
  assert.equal(isMainModule(url, path.join(dir, 'other.mjs')), false);
  assert.equal(isMainModule(url, undefined), false);
});
