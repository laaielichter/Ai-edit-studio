// One installer for buyers: data folder, FFmpeg check and every agent door found on this computer —
// Claude Code (plugin), OpenAI Codex (MCP + skills), Claude Desktop and Cursor (MCP JSON). The OpenAI API
// needs nothing installed (examples/openai). Each step reports done / skipped / failed; nothing is uploaded.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT, StudioError } from './paths.mjs';
import { userSettingsFile, readUserSettings } from './settings.mjs';
import { codexSetup, checkDataRoot, writeUserSettings } from './integrations.mjs';
import { findFfmpegTools, ffmpegInstallHint } from './ffmpeg.mjs';

const SERVER = 'ai-edit-studio';
const PLUGIN = 'ai-edit-studio@ai-edit-studio';

export function findOnPath(name, env = process.env, platform = process.platform) {
  const exts = platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext.toLowerCase());
      try { if (statSync(file).isFile()) return file; } catch { /* next */ }
    }
  }
  return null;
}

export function runCommand(file, args) {
  // .cmd shims on Windows need a shell; quote every argument ourselves.
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
  const quoted = shell ? args.map(a => `"${String(a).replace(/"/g, '""')}"`) : args;
  const r = spawnSync(shell ? `"${file}"` : file, quoted, { encoding: 'utf8', shell, windowsHide: true, timeout: 120000 });
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split(/\r?\n/).slice(-2).join(' ') };
}

/** Add, replace or (entry null) remove our server in an mcpServers JSON file's text. */
export function mergeMcpJson(text, entry) {
  let config = {};
  if (String(text ?? '').trim()) {
    try { config = JSON.parse(text); } catch { throw new StudioError('INVALID_CLIENT_CONFIG', 'The existing config is not valid JSON; fix it by hand first.'); }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new StudioError('INVALID_CLIENT_CONFIG', 'The existing config is not a JSON object.');
  const servers = { ...(config.mcpServers ?? {}) };
  if (entry) servers[SERVER] = entry; else delete servers[SERVER];
  return `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`;
}

export function clientConfigs(env = process.env, platform = process.platform, home = os.homedir()) {
  const desktopDir = platform === 'win32' ? path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude')
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Claude') : path.join(home, '.config', 'Claude');
  return [
    { id: 'desktop', name: 'Claude Desktop', dir: desktopDir, file: path.join(desktopDir, 'claude_desktop_config.json') },
    { id: 'cursor', name: 'Cursor', dir: path.join(home, '.cursor'), file: path.join(home, '.cursor', 'mcp.json') },
  ];
}

async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }

async function updateJsonClient(client, entry, dryRun) {
  if (!(await exists(client.dir))) return { step: client.name, status: 'skipped', detail: 'not installed' };
  const before = await fs.readFile(client.file, 'utf8').catch(() => '');
  const after = mergeMcpJson(before, entry);
  if (before === after) return { step: client.name, status: 'done', detail: 'already up to date' };
  if (!dryRun) {
    if (before) await fs.writeFile(`${client.file}.bak-ai-edit-studio`, before);
    await fs.writeFile(client.file, after);
  }
  return { step: client.name, status: dryRun ? 'planned' : 'done', detail: `${entry ? 'MCP server added to' : 'removed from'} ${client.file}; restart ${client.name}` };
}

/** Is there an FFmpeg the engine will use, and can it draw text and captions? */
export function checkFfmpeg() {
  let tools;
  try { tools = findFfmpegTools(); } catch { return { status: 'failed', detail: `not found — ${ffmpegInstallHint()}` }; }
  const r = spawnSync(tools.ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const filters = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const missing = ['drawtext', 'ass', 'xfade'].filter(f => !new RegExp(`^\\s*\\S+\\s+${f}\\s`, 'm').test(filters));
  return missing.length
    ? { status: 'failed', detail: `${tools.ffmpeg} cannot render ${missing.join(', ')} (text, captions, transitions) — ${ffmpegInstallHint()}` }
    : { status: 'done', detail: tools.ffmpeg };
}

export async function install({
  dataRoot, clients = {}, dryRun = false, uninstall = false,
  env = process.env, platform = process.platform, home = os.homedir(), engine = PROJECT_ROOT, node = process.execPath,
  which = name => findOnPath(name, env, platform), run = runCommand, ffmpegCheck = checkFfmpeg,
} = {}) {
  const want = id => clients[id] !== false;
  const steps = [];
  const launcher = path.join(engine, 'plugin', 'mcp-launch.mjs');
  const settingsFile = userSettingsFile(env, platform, home);
  const previous = readUserSettings(settingsFile);

  if (!uninstall) {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 20) throw new StudioError('NODE_TOO_OLD', `Node ${process.versions.node} found; AI Edit Studio needs Node 20 or newer (nodejs.org).`);
    const root = checkDataRoot(dataRoot) ?? previous.dataRoot ?? (platform === 'win32' ? undefined : path.join(home, 'AI-Edit-Studio'));
    if (!root) throw new StudioError('DATA_ROOT_REQUIRED', 'Choose where projects and renders go: node cli.mjs install --data-root D:\\AI-Edit-Studio');
    if (!dryRun) {
      await fs.mkdir(root, { recursive: true });
      await writeUserSettings({ engine, dataRoot: root }, { env, platform, home });
    }
    steps.push({ step: 'Data folder', status: dryRun ? 'planned' : 'done', detail: `${root} (settings: ${settingsFile})` });
    steps.push({ step: 'FFmpeg', ...ffmpegCheck() });
  }

  if (want('claude')) {
    const claude = which('claude');
    if (!claude) steps.push({ step: 'Claude Code', status: 'skipped', detail: 'not installed' });
    else if (dryRun) steps.push({ step: 'Claude Code', status: 'planned', detail: `plugin ${PLUGIN} from ${engine}` });
    else {
      run(claude, ['plugin', 'uninstall', PLUGIN]);
      run(claude, ['plugin', 'marketplace', 'remove', SERVER]); // re-add so an upgrade points at this folder
      if (uninstall) steps.push({ step: 'Claude Code', status: 'done', detail: 'plugin removed' });
      else {
        const added = run(claude, ['plugin', 'marketplace', 'add', engine]);
        const installed = added.ok ? run(claude, ['plugin', 'install', PLUGIN]) : added;
        steps.push({ step: 'Claude Code', status: installed.ok ? 'done' : 'failed', detail: installed.ok ? 'plugin installed — tools, 6 skills, video-director agent' : installed.output });
      }
    }
  }

  if (want('codex')) {
    const found = which('codex') || await exists(env.CODEX_HOME?.trim() || path.join(home, '.codex'));
    if (!found) steps.push({ step: 'OpenAI Codex', status: 'skipped', detail: 'not installed' });
    else {
      try {
        const r = await codexSetup({ mode: uninstall ? 'uninstall' : 'full', dryRun, env, platform, home, engine, node });
        steps.push({ step: 'OpenAI Codex', status: dryRun ? 'planned' : 'done', detail: uninstall ? 'MCP server and skills removed' : `MCP server in ${r.codexHome}${path.sep}config.toml + ${r.skills.length} skills; restart Codex` });
      } catch (e) { steps.push({ step: 'OpenAI Codex', status: 'failed', detail: e.message }); }
    }
  }

  for (const client of clientConfigs(env, platform, home)) {
    if (!want(client.id)) continue;
    try { steps.push(await updateJsonClient(client, uninstall ? null : { command: node, args: [launcher] }, dryRun)); }
    catch (e) { steps.push({ step: client.name, status: 'failed', detail: e.message }); }
  }

  if (uninstall) {
    if (!dryRun) await fs.rm(settingsFile, { force: true });
    steps.push({ step: 'Settings', status: dryRun ? 'planned' : 'done', detail: `removed ${settingsFile}; your projects and renders stay in ${previous.dataRoot ?? 'the data folder'}` });
  } else {
    steps.push({ step: 'OpenAI API / Agents SDK', status: 'done', detail: 'nothing to install — see examples/openai (your own OPENAI_API_KEY)' });
  }
  return { ok: !steps.some(s => s.status === 'failed'), dryRun, uninstall, engine, steps };
}

export function formatReport(report) {
  const icon = { done: '✔', planned: '•', skipped: '–', failed: '✖' };
  const lines = report.steps.map(s => `${icon[s.status] ?? '?'} ${s.step.padEnd(24)} ${s.detail}`);
  const head = report.uninstall ? 'AI Edit Studio — uninstall' : 'AI Edit Studio — install';
  const tail = report.uninstall ? '' : report.ok
    ? '\nReady. Start the editor (Start-AI-Edit-Studio on Windows, ./start.sh on macOS/Linux) or ask your agent: "Use AI Edit Studio to make a TikTok from <video>".'
    : '\nSome steps need attention (✖). Fix them and run the installer again; it is safe to repeat.';
  return `${head}${report.dryRun ? ' (dry run, nothing changed)' : ''}\n\n${lines.join('\n')}\n${tail}\n`;
}
