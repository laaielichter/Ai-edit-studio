// Agent-client integrations: Codex (OpenAI) setup and the per-user settings the Codex plugin reads.
// Only files we own are written: one marked block in config.toml (backed up first), our prefixed skill
// folders and the settings file (merged). Everything except the settings file is reversible with --uninstall;
// `node cli.mjs uninstall` removes the settings file too.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT, StudioError } from './paths.mjs';
import { readUserSettings, userSettingsFile } from './settings.mjs';
import { STUDIO_VERSION } from './agent-tools.mjs';

export const SKILL_PREFIX = 'ai-edit-studio-';
const BEGIN = '# >>> ai-edit-studio (managed by `node cli.mjs codex-setup`; edit there, not here) >>>';
const END = '# <<< ai-edit-studio <<<';
const BLOCK = new RegExp(`\\n?${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END}\\n?`);
const FOREIGN_SERVER = /^\s*\[\s*mcp_servers\s*\.\s*(?:"ai-edit-studio"|'ai-edit-studio'|ai-edit-studio)\s*\]/m;
const toml = value => JSON.stringify(String(value));

export const codexPaths = (env = process.env, home = os.homedir()) => {
  const codex = env.CODEX_HOME?.trim() || path.join(home, '.codex');
  return { codex, config: path.join(codex, 'config.toml'), skills: path.join(home, '.agents', 'skills') };
};

export function codexBlock({ node = process.execPath, launcher }) {
  return [BEGIN,
    '[mcp_servers.ai-edit-studio]',
    `command = ${toml(node)}`,
    `args = [${toml(launcher)}]`,
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 300   # studio_wait long-polls up to 280 s',
    END].join('\n');
}

/** Returns the new config text: our block replaced/added/removed, everything else untouched. */
export function mergeCodexConfig(text, block) {
  const without = String(text ?? '').replace(BLOCK, '\n').replace(/\n{3,}$/, '\n\n');
  if (block && FOREIGN_SERVER.test(without)) {
    throw new StudioError('CODEX_CONFIG_CONFLICT', 'config.toml already has [mcp_servers.ai-edit-studio] (added by hand). Remove that table, then run codex-setup again.');
  }
  if (!block) return without.trim() ? `${without.trimEnd()}\n` : '';
  return `${without.trimEnd()}${without.trim() ? '\n\n' : ''}${block}\n`;
}

export const renameSkill = (text, name) => text.replace(/^(---\n[\s\S]*?^name: ).+$/m, `$1${name}`);

async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function readOr(file, fallback) { try { return await fs.readFile(file, 'utf8'); } catch { return fallback; } }

/** Merge into the per-user settings file (engine location, chosen data folder). */
export async function writeUserSettings(patch, { env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const file = userSettingsFile(env, platform, home);
  const next = { ...readUserSettings(file), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), version: STUDIO_VERSION };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
  return { file, settings: next };
}

export function checkDataRoot(dataRoot) {
  if (dataRoot === undefined) return undefined;
  const value = String(dataRoot).trim();
  if (!path.isAbsolute(value) || value.startsWith('\\\\')) throw new StudioError('INVALID_DATA_ROOT', 'Choose an absolute local folder for the data (no network path).');
  return path.resolve(value);
}

/**
 * mode "full"   → MCP server in config.toml + skills in ~/.agents/skills (no plugin needed)
 * mode "plugin" → our config block/skills removed (the Codex plugin brings both)
 * mode "uninstall" → remove the config block and skills
 * Every mode except uninstall records the engine location in the settings file for the plugin bootstrap.
 */
export async function codexSetup({ mode = 'full', dataRoot, dryRun = false, env = process.env, platform = process.platform, home = os.homedir(), engine = PROJECT_ROOT, node = process.execPath } = {}) {
  if (!['full', 'plugin', 'uninstall'].includes(mode)) throw new StudioError('INVALID_ARGUMENTS', 'mode: full, plugin or uninstall.');
  const where = codexPaths(env, home);
  const launcher = path.join(engine, 'plugin', 'mcp-launch.mjs');
  const chosenRoot = checkDataRoot(dataRoot);
  const settingsFile = userSettingsFile(env, platform, home);
  if (mode !== 'uninstall' && platform === 'win32' && !chosenRoot && !readUserSettings(settingsFile).dataRoot) {
    throw new StudioError('DATA_ROOT_REQUIRED', 'On Windows choose a data folder first: node cli.mjs codex-setup --data-root D:\\AI-Edit-Studio (or run the installer).');
  }
  const skillNames = (await fs.readdir(path.join(engine, 'skills'), { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name);
  const before = await readOr(where.config, '');
  const after = mergeCodexConfig(before, mode === 'full' ? codexBlock({ node, launcher }) : null);
  const skillDirs = skillNames.map(n => path.join(where.skills, SKILL_PREFIX + n));
  const plan = {
    mode, engine, codexHome: where.codex,
    config: before === after ? 'unchanged' : where.config,
    skills: mode === 'full' ? skillDirs : [],
    removeSkills: mode === 'full' ? [] : skillDirs,
    settings: mode === 'uninstall' ? null : settingsFile,
    dataRoot: chosenRoot ?? readUserSettings(settingsFile).dataRoot ?? null,
  };
  if (dryRun) return { dryRun: true, ...plan };

  if (before !== after) {
    await fs.mkdir(where.codex, { recursive: true });
    if (before) await fs.writeFile(`${where.config}.bak-ai-edit-studio`, before);
    await fs.writeFile(where.config, after);
  }
  for (const name of skillNames) {
    const dir = path.join(where.skills, SKILL_PREFIX + name);
    if (mode === 'full') {
      await fs.mkdir(dir, { recursive: true });
      const text = await fs.readFile(path.join(engine, 'skills', name, 'SKILL.md'), 'utf8');
      await fs.writeFile(path.join(dir, 'SKILL.md'), renameSkill(text, SKILL_PREFIX + name));
    } else if (await exists(dir)) await fs.rm(dir, { recursive: true, force: true });
  }
  if (mode !== 'uninstall') await writeUserSettings({ engine, dataRoot: chosenRoot }, { env, platform, home });
  return { ok: true, ...plan, next: mode === 'full' ? 'Restart Codex; /mcp should list ai-edit-studio.' : mode === 'plugin' ? 'codex plugin marketplace add <this folder>, then install ai-edit-studio and restart Codex.' : 'Removed. Restart Codex.' };
}
