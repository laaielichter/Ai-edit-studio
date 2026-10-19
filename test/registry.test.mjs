import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = async file => JSON.parse(await fs.readFile(path.join(ROOT, file), 'utf8'));
const { agentTools, STUDIO_VERSION } = await import('../src/agent-tools.mjs');

test('MCP Registry entry agrees with the npm package, so publishing cannot fail on a mismatch', async () => {
  const pkg = await json('package.json'), server = await json('server.json');
  assert.equal(server.name, pkg.mcpName, 'server.json name must equal mcpName in package.json');
  assert.match(server.name, /^io\.github\.laaielichter\/[a-z0-9-]+$/, 'GitHub login needs the io.github.<owner>/ prefix');
  assert.equal(server.version, pkg.version); assert.equal(server.version, STUDIO_VERSION);
  assert.ok(server.description.length > 0 && server.description.length <= 100, 'registry descriptions are at most 100 characters');
  assert.equal(server.repository.url, `https://github.com/laaielichter/${pkg.name}`); assert.equal(server.repository.source, 'github');
  const [npm, ...more] = server.packages;
  assert.equal(more.length, 0);
  assert.equal(npm.registryType, 'npm'); assert.equal(npm.identifier, pkg.name); assert.equal(npm.version, pkg.version);
  assert.equal(npm.transport.type, 'stdio');
  assert.deepEqual(npm.packageArguments.map(a => a.value), ['mcp'], 'npx ai-edit-studio mcp starts the MCP server');
  for (const file of ['.claude-plugin/plugin.json', 'plugins/ai-edit-studio/.codex-plugin/plugin.json']) assert.equal((await json(file)).version, pkg.version, file);
  assert.equal((await json('.agents/plugins/marketplace.json')).plugins[0].version, pkg.version);
  assert.ok(Object.values(pkg.bin).includes('mcp.mjs') && pkg.bin['ai-edit-studio'] === 'cli.mjs');
});

test('`cli.mjs mcp` (what npx runs for the registry) speaks MCP on stdout and prints nothing else first', async () => {
  const child = spawn(process.execPath, [path.join(ROOT, 'cli.mjs'), 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GAME_TRAILER_STUDIO_DATA_ROOT: path.join(ROOT, '.studio-data', 'registry-test') } });
  let out = '';
  const lines = [];
  const waiting = [];
  child.stdout.on('data', chunk => {
    out += chunk;
    let i;
    while ((i = out.indexOf('\n')) >= 0) { lines.push(out.slice(0, i)); out = out.slice(i + 1); waiting.splice(0).forEach(fn => fn()); }
  });
  const next = async () => { while (!lines.length) await new Promise(resolve => { waiting.push(resolve); setTimeout(resolve, 15000).unref(); if (lines.length) resolve(); }); return JSON.parse(lines.shift()); };
  const send = message => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  try {
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'registry-test', version: '1' } } });
    const init = await next();
    assert.equal(init.id, 1); assert.equal(init.result.serverInfo.name, 'ai-edit-studio'); assert.equal(init.result.serverInfo.version, STUDIO_VERSION);
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list' });
    const listed = await next();
    assert.equal(listed.id, 2); assert.equal(listed.result.tools.length, agentTools.length);
    assert.ok(listed.result.tools.some(t => t.name === 'studio_render'));
  } finally { child.kill(); }
});
