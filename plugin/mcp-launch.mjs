// Plugin entry for the MCP server. A plugin is installed into a cache folder that is replaced on every
// update, so projects and renders must not live next to the code (the engine's default on macOS/Linux).
// Without a data root (env or the installer's settings file) we use ~/.ai-edit-studio there. On Windows the engine's own rule stays:
// it never silently falls back to C:, so choose a folder with AI_EDIT_STUDIO_DATA_ROOT (or the
// GAME_TRAILER_STUDIO_DATA_ROOT + GAME_TRAILER_STUDIO_ALLOW_CUSTOM_DRIVE=1 pair).
import os from 'node:os';
import path from 'node:path';
import { readUserSettings, userSettingsFile } from '../src/settings.mjs';
import { isMainModule } from '../src/main-module.mjs';

export function pluginEnv(env = process.env, platform = process.platform, home = os.homedir(), settings = readUserSettings(userSettingsFile(env, platform, home))) {
  if (env.GAME_TRAILER_STUDIO_DATA_ROOT?.trim()) return {};
  const chosen = env.AI_EDIT_STUDIO_DATA_ROOT?.trim();
  if (chosen) return { GAME_TRAILER_STUDIO_DATA_ROOT: chosen, GAME_TRAILER_STUDIO_ALLOW_CUSTOM_DRIVE: '1' };
  if (String(settings.dataRoot ?? '').trim()) return {}; // chosen in the installer; paths.mjs reads it
  if (platform === 'win32' || !home) return {};
  return { GAME_TRAILER_STUDIO_DATA_ROOT: path.join(home, '.ai-edit-studio') };
}

export async function main() {
  Object.assign(process.env, pluginEnv());
  await import('../mcp.mjs');
}

if (isMainModule(import.meta.url)) await main();
