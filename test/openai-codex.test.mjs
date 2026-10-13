import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const { agentTools, openAiTools } = await import('../src/agent-tools.mjs');
const { codexSetup, mergeCodexConfig, codexBlock } = await import('../src/integrations.mjs');
const { expectedFiles } = await import('../tools/sync-codex-plugin.mjs');
const { runAgent, splitImage, instructionsFor } = await import('../examples/openai/openai-agent.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'aes-codex-'));

test('OpenAI function tools mirror the agent tools in both API styles', () => {
  const responses = openAiTools(), chat = openAiTools('chat');
  assert.equal(responses.length, agentTools.length);
  for (const [i, tool] of agentTools.entries()) {
    assert.deepEqual(responses[i], { type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false });
    assert.equal(chat[i].function.name, tool.name);
    assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.ok(tool.description.length <= 1024, `${tool.name}: description too long for OpenAI`);
    assert.equal(tool.inputSchema.type, 'object');
  }
});

test('Responses loop runs tool calls, attaches images and returns the final text', async () => {
  const requests = [];
  const replies = [
    { id: 'r1', output: [{ type: 'function_call', call_id: 'c1', name: 'studio_frame', arguments: '{"projectId":"p"}' }, { type: 'function_call', call_id: 'c2', name: 'studio_get', arguments: '{}' }] },
    { id: 'r2', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done: 3 clips.' }] }] },
  ];
  const fetchImpl = async (url, init) => { requests.push(JSON.parse(init.body)); return { ok: true, json: async () => replies.shift() }; };
  const calls = [];
  const callTool = async (name, args) => {
    calls.push([name, args]);
    if (name === 'studio_get') throw Object.assign(new Error('busy'), { code: 'ENGINE_BUSY' });
    return { frame: { time: 1, imageBase64: 'QUJD' } };
  };
  const text = await runAgent({ prompt: 'go', instructions: 'x', apiKey: 'k', fetchImpl, callTool });
  assert.equal(text, 'Done: 3 clips.');
  assert.deepEqual(calls, [['studio_frame', { projectId: 'p' }], ['studio_get', {}]]);
  assert.equal(requests[0].tools.length, agentTools.length);
  assert.equal(requests[1].previous_response_id, 'r1');
  const [out1, out2, images] = requests[1].input;
  assert.equal(out1.call_id, 'c1');
  assert.ok(!out1.output.includes('QUJD'), 'base64 is not sent as text');
  assert.match(out2.output, /ENGINE_BUSY/);
  assert.equal(images.content[1].image_url, 'data:image/jpeg;base64,QUJD');
  assert.deepEqual(splitImage({ ok: true }), { output: { ok: true }, image: null });
  assert.match(await instructionsFor('viral-short'), /Viral short from raw footage[\s\S]*Quality gate/);
});

test('codex-setup merges one managed block, installs skills and uninstalls cleanly', async () => {
  const home = await temp();
  const env = { CODEX_HOME: path.join(home, '.codex'), XDG_CONFIG_HOME: path.join(home, '.config') };
  await fs.mkdir(env.CODEX_HOME, { recursive: true });
  const config = path.join(env.CODEX_HOME, 'config.toml');
  const settingsFile = path.join(home, '.config', 'ai-edit-studio', 'settings.json');
  const original = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n';
  await fs.writeFile(config, original);
  const opts = { env, home, platform: 'linux', node: '/usr/bin/node', dataRoot: '/data/studio' };

  const dry = await codexSetup({ ...opts, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(await fs.readFile(config, 'utf8'), original, 'dry run writes nothing');

  await codexSetup(opts);
  await codexSetup(opts);
  const text = await fs.readFile(config, 'utf8');
  assert.ok(text.startsWith(original));
  assert.equal(text.match(/\[mcp_servers\.ai-edit-studio\]/g).length, 1, 'idempotent');
  assert.match(text, /tool_timeout_sec = 300/);
  const skill = await fs.readFile(path.join(home, '.agents', 'skills', 'ai-edit-studio-viral-short', 'SKILL.md'), 'utf8');
  assert.match(skill, /^name: ai-edit-studio-viral-short$/m);
  const settings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  assert.equal(settings.engine, ROOT);
  assert.equal(settings.dataRoot, path.resolve('/data/studio'));

  await codexSetup({ ...opts, mode: 'plugin' });
  assert.equal(await fs.readFile(config, 'utf8'), original, 'plugin mode removes our server block');
  await assert.rejects(fs.access(path.join(home, '.agents', 'skills', 'ai-edit-studio-viral-short')));
  await fs.access(settingsFile);

  await codexSetup({ ...opts, mode: 'uninstall' });
  assert.equal(await fs.readFile(config, 'utf8'), original);
  await fs.access(settingsFile); // owned by the installer; `node cli.mjs uninstall` removes it
});

test('codex-setup refuses to duplicate a hand-written server table', () => {
  const block = codexBlock({ node: 'node', launcher: '/x/mcp-launch.mjs' });
  assert.throws(() => mergeCodexConfig('[mcp_servers."ai-edit-studio"]\ncommand = "node"\n', block), { code: 'CODEX_CONFIG_CONFLICT' });
  assert.equal(mergeCodexConfig('', block), `${block}\n`);
  assert.match(codexBlock({ node: 'C:\\node.exe', launcher: 'D:\\a "b"\\l.mjs' }), /args = \["D:\\\\a \\"b\\"\\\\l\.mjs"\]/);
});

test('Codex plugin folder is generated from the shared skills and is up to date', async () => {
  for (const [rel, content] of await expectedFiles()) {
    assert.equal((await fs.readFile(path.join(ROOT, 'plugins', 'ai-edit-studio', rel), 'utf8')).replace(/\r\n/g, '\n'), content, `${rel} is stale: run node tools/sync-codex-plugin.mjs`);
  }
  const market = JSON.parse(await fs.readFile(path.join(ROOT, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  assert.equal(market.plugins[0].source.path, './plugins/ai-edit-studio');
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'plugins', 'ai-edit-studio', '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(market.plugins[0].version, manifest.version);
});

test('Codex plugin MCP bootstrap finds the engine through the settings file and speaks MCP', async () => {
  const home = await temp();
  const env = { CODEX_HOME: path.join(home, '.codex'), XDG_CONFIG_HOME: path.join(home, '.config'), APPDATA: path.join(home, 'AppData', 'Roaming') };
  await codexSetup({ env, home, platform: process.platform, mode: 'plugin', dataRoot: path.join(home, 'data') });
  const server = JSON.parse(await fs.readFile(path.join(ROOT, 'plugins', 'ai-edit-studio', '.mcp.json'), 'utf8')).mcpServers['ai-edit-studio'];
  const child = spawn(server.command, server.args, { cwd: os.tmpdir(), env: { ...process.env, ...env, HOME: home, USERPROFILE: home, AI_EDIT_STUDIO_HOME: '' } });
  const reply = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', d => { out += d; const line = out.split('\n').find(l => l.includes('"id":1')); if (line) resolve(JSON.parse(line)); });
    child.on('exit', code => reject(new Error(`exited ${code}`)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
  });
  child.kill();
  assert.equal(reply.result.serverInfo.name, 'ai-edit-studio');
});
