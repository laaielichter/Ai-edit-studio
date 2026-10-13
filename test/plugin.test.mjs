import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { agentTools, STUDIO_VERSION } = await import('../src/agent-tools.mjs');
const { BUILTIN_RECIPES } = await import('../src/recipes.mjs');
const { TEMPLATES } = await import('../src/templates.mjs');
const { pluginEnv } = await import('../plugin/mcp-launch.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFile(path.join(ROOT, file), 'utf8');
const toolNames = new Set(agentTools.map(t => t.name));
const enumOf = (tool, prop) => agentTools.find(t => t.name === tool).inputSchema.properties[prop].enum;

async function pluginDocs() {
  const files = ['agents/video-director.md', 'TROUBLESHOOTING.md', 'docs/INTEGRATIONS.md', 'examples/openai/README.md', 'INSTALL.md', 'SUPPORT.md'];
  for (const dir of await fs.readdir(path.join(ROOT, 'skills'))) files.push(`skills/${dir}/SKILL.md`);
  return Promise.all(files.map(async file => ({ file, text: await read(file) })));
}

test('plugin manifest starts the MCP server through an existing launcher', async () => {
  const manifest = JSON.parse(await read('.claude-plugin/plugin.json'));
  assert.equal(manifest.name, 'ai-edit-studio');
  assert.equal(manifest.version, STUDIO_VERSION);
  const server = manifest.mcpServers['ai-edit-studio'];
  assert.equal(server.command, 'node');
  const launcher = server.args[0].replace('${CLAUDE_PLUGIN_ROOT}', ROOT);
  await fs.access(launcher);
  const market = JSON.parse(await read('.claude-plugin/marketplace.json'));
  assert.deepEqual(market.plugins.map(p => [p.name, p.source]), [['ai-edit-studio', './']]);
});

test('plugin keeps data out of the replaceable plugin folder', () => {
  assert.deepEqual(pluginEnv({}, 'linux', '/home/a'), { GAME_TRAILER_STUDIO_DATA_ROOT: path.join('/home/a', '.ai-edit-studio') });
  assert.deepEqual(pluginEnv({ GAME_TRAILER_STUDIO_DATA_ROOT: '/data' }, 'linux', '/home/a'), {});
  assert.deepEqual(pluginEnv({ AI_EDIT_STUDIO_DATA_ROOT: 'D:\\Studio' }, 'win32', 'C:\\Users\\a'),
    { GAME_TRAILER_STUDIO_DATA_ROOT: 'D:\\Studio', GAME_TRAILER_STUDIO_ALLOW_CUSTOM_DRIVE: '1' });
  assert.deepEqual(pluginEnv({}, 'win32', 'C:\\Users\\a'), {}, 'Windows never silently picks a data drive');
});

test('every skill has matching frontmatter', async () => {
  for (const dir of await fs.readdir(path.join(ROOT, 'skills'))) {
    const text = await read(`skills/${dir}/SKILL.md`);
    const front = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
    assert.ok(front, `${dir}: frontmatter`);
    assert.match(front, new RegExp(`^name: ${dir}$`, 'm'));
    assert.match(front, /^description: .{80,}$/m);
  }
});

test('skills, agent and docs only mention tools, recipes, templates and platforms that exist', async () => {
  const recipes = new Set(Object.keys(BUILTIN_RECIPES));
  const templates = new Set(TEMPLATES.map(t => t.id));
  const platforms = new Set([...enumOf('studio_auto_edit', 'platform'), ...enumOf('studio_find_clips', 'platform')]);
  for (const { file, text } of await pluginDocs()) {
    for (const [name] of text.matchAll(/studio_[a-z_]+/g)) assert.ok(toolNames.has(name), `${file}: unknown tool ${name}`);
    for (const [, name] of text.matchAll(/name:"([a-z-]+)"/g)) assert.ok(recipes.has(name), `${file}: unknown recipe ${name}`);
    for (const [, id] of text.matchAll(/template:"([a-z-]+)"/g)) assert.ok(templates.has(id), `${file}: unknown template ${id}`);
    for (const [, id] of text.matchAll(/platform:"([a-z]+)"/g)) assert.ok(platforms.has(id), `${file}: unknown platform ${id}`);
  }
});
