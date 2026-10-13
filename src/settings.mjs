// Per-user settings written by `node cli.mjs install` / `codex-setup`: the data folder the person chose and
// where the engine lives (for the Codex plugin). No side effects on import: launchers read it before paths.mjs.
// Windows: %APPDATA%\AI Edit Studio\settings.json, elsewhere ~/.config/ai-edit-studio/settings.json.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function userSettingsFile(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'AI Edit Studio', 'settings.json');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'ai-edit-studio', 'settings.json');
}

export function readUserSettings(file = userSettingsFile()) {
  try { return JSON.parse(readFileSync(file, 'utf8')) ?? {}; } catch { return {}; }
}
