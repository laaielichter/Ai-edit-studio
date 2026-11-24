import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentTools, OPERATIONS, OPERATION_GUIDE, STUDIO_VERSION } from '../src/agent-tools.mjs';
import { TEXT_STYLES } from '../public/edit-ops.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFile(path.join(ROOT, file), 'utf8');
const DOC_FILES = [
  'README.md',
  'AGENTS.md',
  'INSTALL.md',
  'package.json',
  'server.json',
  'docs/INTEGRATIONS.md',
  '.claude-plugin/plugin.json',
  'plugins/ai-edit-studio/.codex-plugin/plugin.json',
  'examples/openai/openai-agent.mjs',
  'public/index.html',
  'public/launch.html',
];

test('documented tool counts match the agent tool catalog', async () => {
  for (const file of DOC_FILES) {
    let content = await read(file);
    if (file === 'AGENTS.md') {
      content = content.split('\n').filter(line => !line.startsWith('## New in ')).join('\n');
    }
    const matches = [...content.matchAll(/\b(\d+)\s+(?:(?:MCP|editing)\s+|agent-)?tools\b/gi)];
    assert.ok(matches.length > 0, file + ': expected at least one documented tool count');
    for (const match of matches) {
      assert.equal(Number(match[1]), agentTools.length, file + ': stale tool count in "' + match[0] + '"');
    }
  }
});

test('README and editor version labels match the engine major and minor version', async () => {
  const expected = STUDIO_VERSION.split('.').slice(0, 2).join('.');
  const readme = await read('README.md');
  const editor = await read('public/index.html');
  const readmeVersion = readme.match(/^# .*Director\s+(\d+\.\d+)/m)?.[1];
  const editorVersion = editor.match(/DIRECTOR\s+(\d+\.\d+)/)?.[1];
  assert.equal(readmeVersion, expected, 'README.md heading');
  assert.equal(editorVersion, expected, 'public/index.html brand label');
});

test('studio_edit points to the complete operation guide', () => {
  const edit = agentTools.find(tool => tool.name === 'studio_edit');
  assert.ok(edit, 'studio_edit tool exists');
  assert.match(edit.description, /studio_schema/);
  assert.deepEqual(Object.keys(OPERATION_GUIDE).sort(), [...OPERATIONS].sort());
  for (const style of Object.keys(TEXT_STYLES)) {
    assert.ok(OPERATION_GUIDE.add_text.includes(`"${style}"`), 'add_text guide is missing style ' + style);
  }
});
