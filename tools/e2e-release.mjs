// End-to-end test of the download as a buyer would get it, in a throw-away home folder:
// build the zip → unpack → run the real installer (install.ps1 on Windows, install.sh elsewhere) →
// start the MCP server exactly as written into the Codex config → create a project from a generated clip →
// auto-edit + vertical render → render QC must pass → Codex plugin bootstrap answers → uninstall cleans up.
//   node tools/e2e-release.mjs            (needs Node 20+ and FFmpeg on PATH; takes a few minutes)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildRelease, unzip } from './build-release.mjs';
import { findFfmpegTools } from '../src/ffmpeg.mjs';

const win = process.platform === 'win32';
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'aes-e2e-'));
const home = path.join(work, 'home');
const dataRoot = path.join(work, 'My Videos', 'AI Edit Studio'); // spaces on purpose
const port = String(33000 + Math.floor(Math.random() * 2000));
const env = {
  ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'),
  XDG_CONFIG_HOME: path.join(home, '.config'), CODEX_HOME: path.join(home, '.codex'), GAME_TRAILER_STUDIO_PORT: port,
};
delete env.GAME_TRAILER_STUDIO_DATA_ROOT; delete env.AI_EDIT_STUDIO_DATA_ROOT; delete env.AI_EDIT_STUDIO_HOME;
const step = (name) => console.log(`\n== ${name}`);
const fail = (message) => { console.error(`\nE2E FAILED: ${message}`); process.exit(1); };
const check = (ok, message) => { if (!ok) fail(message); console.log(`ok - ${message}`); };

step('build and unpack the release zip');
const release = await buildRelease({ outDir: path.join(work, 'dist') });
const apps = path.join(work, 'Program Files');
for (const [name, { data, mode }] of unzip(await fs.readFile(release.file))) {
  const file = path.join(apps, ...name.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data, { mode: mode & 0o777 || 0o644 });
}
const engine = path.join(apps, path.basename(release.file, '.zip'));
check((await fs.stat(path.join(engine, 'cli.mjs'))).isFile(), `unpacked ${release.files} files to ${engine}`);
await fs.mkdir(env.CODEX_HOME, { recursive: true }); // pretend Codex is installed

step('run the installer');
const installer = win
  ? spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(engine, 'install.ps1'), '-DataRoot', dataRoot, '-Unattended', '--no-claude'], { env, encoding: 'utf8' })
  : spawnSync(path.join(engine, 'install.sh'), ['--data-root', dataRoot, '--no-claude'], { env, encoding: 'utf8' });
console.log(`${installer.stdout ?? ''}${installer.stderr ?? ''}`.trim());
check(installer.status === 0, 'installer exited 0');
const config = await fs.readFile(path.join(env.CODEX_HOME, 'config.toml'), 'utf8');
check(/\[mcp_servers\.ai-edit-studio\]/.test(config), 'Codex config has the MCP server');
const skills = await fs.readdir(path.join(home, '.agents', 'skills'));
check(skills.filter(n => n.startsWith('ai-edit-studio-')).length === 6, 'six Codex skills installed');

async function mcp(command, args, label) {
  const child = spawn(command, args, { env, cwd: work });
  let buf = '', id = 0, stderr = '', closing = false;
  const waiting = new Map();
  child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); const m = JSON.parse(line); waiting.get(m.id)?.(m); } });
  child.stderr.on('data', d => { stderr += d; });
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  const rpc = (method, params) => Promise.race([
    new Promise(resolve => { const n = ++id; waiting.set(n, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`); }),
    exited.then(code => closing || fail(`${label} exited (${code}): ${stderr.trim()}`)),
  ]);
  const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const call = async (name, a = {}) => {
    const m = await rpc('tools/call', { name, arguments: a });
    const out = JSON.parse(m.result.content[0].text);
    if (m.result.isError) fail(`${name}: ${JSON.stringify(out)}`);
    return out;
  };
  return { init, call, close: () => { closing = true; child.kill(); } };
}

step('make a test clip');
const clip = path.join(work, 'clip één.mp4');
const ff = spawnSync(findFfmpegTools().ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip], { encoding: 'utf8' });
check(ff.status === 0, `test clip ${clip}`);

step('edit and render through the MCP server registered for Codex');
const command = JSON.parse(config.match(/^command = (".*")$/m)[1]);
const args = JSON.parse(config.match(/^args = (\[.*\])$/m)[1]);
const studio = await mcp(command, args, 'MCP server');
check(studio.init.result?.serverInfo?.name === 'ai-edit-studio', 'MCP initialize');
const doctor = await studio.call('studio_doctor');
check(path.resolve(doctor.dataRoot) === path.resolve(dataRoot), `engine uses the installer's data folder (${doctor.dataRoot})`);
const created = await studio.call('studio_create', { name: 'E2E', inputs: [clip], options: { label: '', endTitle: '' } });
const projectId = created.project?.id ?? created.id;
check(Boolean(projectId), `project ${projectId}`);
await studio.call('studio_auto_edit', { projectId, platform: 'tiktok', hookText: 'WAIT FOR IT', render: true, formats: ['vertical'], queue: true });
for (let i = 0; i < 8; i += 1) { const w = await studio.call('studio_wait', { projectId, until: 'idle', timeoutSeconds: 120 }); if (!w.timedOut) break; }
const project = (await studio.call('studio_get', { projectId })).project;
if (project.status !== 'ready') {
  console.log(JSON.stringify({ status: project.status, message: project.message, error: project.error, lastError: project.lastError,
    exports: project.exports, ffmpeg: doctor.dependencies?.ffmpeg?.version, capabilities: doctor.capabilities ?? doctor.dependencies?.capabilities }, null, 1).slice(0, 6000));
}
check(project.status === 'ready', `project ready (review ${project.autoEdit?.review?.score ?? '?'}/100)`);
const qcResult = await studio.call('studio_qc', { projectId });
const qc = qcResult.qc ?? qcResult;
console.log(JSON.stringify({ loudness: qc.loudness, truePeak: qc.truePeak, duration: qc.duration, issues: qc.issues?.map(i => i.code) }));
check(qc.passed === true, 'render QC passed');
check(path.resolve(qc.file).startsWith(path.resolve(dataRoot)), 'render is inside the data folder');
studio.close();

step('Codex plugin bootstrap');
const plugin = JSON.parse(await fs.readFile(path.join(engine, 'plugins', 'ai-edit-studio', '.mcp.json'), 'utf8')).mcpServers['ai-edit-studio'];
const viaPlugin = await mcp(plugin.command, plugin.args, 'Codex plugin bootstrap');
check(viaPlugin.init.result?.serverInfo?.name === 'ai-edit-studio', 'plugin bootstrap finds the engine through the settings file');
viaPlugin.close();

step('uninstall');
const un = spawnSync(process.execPath, [path.join(engine, 'cli.mjs'), 'uninstall', '--no-claude'], { env, encoding: 'utf8' });
console.log(`${un.stdout ?? ''}${un.stderr ?? ''}`.trim());
check(un.status === 0, 'uninstall exited 0');
check(!/ai-edit-studio/.test(await fs.readFile(path.join(env.CODEX_HOME, 'config.toml'), 'utf8')), 'Codex config cleaned');
check((await fs.stat(qc.file)).isFile(), 'the render is kept after uninstall');

console.log('\nE2E PASSED');
process.exit(0); // the engine daemon keeps running detached; CI machines are thrown away
