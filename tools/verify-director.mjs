// Synthetic media only. Run against an isolated server/data root, never user projects.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { findFfmpegTools, verifyVideo } from '../src/ffmpeg.mjs';
import { runProcess } from '../src/process.mjs';
import { DATA_ROOT, ensureDataRoot, hashFile, safeResolveWithin, PROJECT_ROOT } from '../src/paths.mjs';
import { callAgentTool } from '../src/agent-tools.mjs';
const output = path.resolve(process.argv[2] || '');
safeResolveWithin(DATA_ROOT, path.relative(DATA_ROOT, output));
await ensureDataRoot(1024 ** 3); await fs.mkdir(output, { recursive: false });
const base = `http://127.0.0.1:${process.env.GAME_TRAILER_STUDIO_PORT || 32147}/api`;
const report = { checks: [], outputs: [], startedAt: new Date().toISOString() };
async function api(route, { method = 'GET', body } = {}) {
  const r = await fetch(base + route, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const v = await r.json(); if (!r.ok) throw new Error(v.error?.message || r.status); return v;
}
async function wait(id) {
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const { project } = await api(`/studio/projects/${id}`);
    if (!['analyzing', 'rendering', 'previewing'].includes(project.status)) { assert.equal(project.status, 'ready', project.errorDetail || project.message); return project; }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Test operation timed out; server task may still be running.');
}
try {
  const tools = findFfmpegTools(), fixture = path.join(output, 'source.mp4'), music = path.join(output, 'music.wav');
  await runProcess(tools.ffmpeg, ['-hide_banner', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=8', '-af', "volume=0:enable='between(t,2,5)'", '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-c:a', 'aac', fixture], { timeoutMs: 60000 });
  await runProcess(tools.ffmpeg, ['-hide_banner', '-nostdin', '-n', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', music], { timeoutMs: 60000 });
  const before = await hashFile(fixture);
  let { project } = await callAgentTool('studio_create', { name: 'Director QA — creators & agents', inputs: [fixture], options: { duration: 8, label: '', endTitle: '', music, look: 'cinema', fadeIn: 0, fadeOut: 0, duckMusic: true, reduceRumble: true } }, api);
  const id = project.id; report.projectId = id;
  await callAgentTool('studio_analyze', { projectId: id, revision: project.revision }, api); project = await wait(id);
  report.checks.push('agent create + asynchronous analysis completed');
  const proposal = await callAgentTool('studio_silence', { projectId: id, revision: project.revision, minSilence: 1 }, api);
  assert.ok(proposal.proposal.removedSeconds > 0); assert.equal((await api(`/studio/projects/${id}`)).project.revision, project.revision);
  report.checks.push('measured silence proposal removes quiet time without changing saved revision');
  const clips = [{ sourceIndex: 0, start: 0, end: 2, speed: 0.5, gain: 0.7, framing: 'fill', zoom: 1.2, focusX: 0.25, focusY: 0.6, mirror: true }, { sourceIndex: 0, start: 6, end: 8, speed: 2, gain: 0.4 }];
  ({ project } = await callAgentTool('studio_update', { projectId: id, revision: project.revision, clips,
    options: { narration: music, narrationStart: 0.5, narrationTrimStart: 0.1, narrationGain: 0.8, sourceChannel: 'left', captions: [{ sourceIndex: 0, start: 0.2, end: 1.8, text: "100%: safe 'text' — slow motion" }, { sourceIndex: 0, start: 6.2, end: 7.8, text: 'A continuous finale' }] } }, api));
  const frame = (await callAgentTool('studio_frame', { projectId: id, sourceIndex: 0, time: 1 }, api)).frame;
  assert.equal(Buffer.from(frame.imageBase64, 'base64')[0], 255); report.checks.push('real source JPEG evidence returned for agents');
  await assert.rejects(() => callAgentTool('studio_render', { projectId: id, revision: project.revision - 1, preview: true }, api));
  report.checks.push('stale render revision rejected before starting work');
  for (const format of ['preview', 'square', 'portrait', 'uhd']) {
    await callAgentTool('studio_render', { projectId: id, revision: project.revision, ...(format === 'preview' ? { preview: true } : { formats: [format] }) }, api);
    project = await wait(id); const rendered = project.exports.at(-1), verified = await verifyVideo(rendered.output, tools);
    assert.ok(Math.abs(verified.duration - 5) < 0.12); assert.ok(verified.audio); assert.equal(rendered.captionCount, 2);
    const dimensions = { preview: [1280, 720], square: [1080, 1080], portrait: [1080, 1350], uhd: [3840, 2160] }[format];
    assert.equal(verified.video.width, dimensions[0]); assert.equal(verified.video.height, dimensions[1]);
    assert.equal(rendered.narration.start, 0.5); assert.equal(rendered.narration.trimStart, 0.1);
    const srt = await fs.readFile(rendered.subtitles, 'utf8'); assert.match(srt, /00:00:00,400 --> 00:00:03,600/); assert.match(srt, /00:00:04,100 --> 00:00:04,900/);
    report.outputs.push({ format, file: rendered.output, width: verified.video.width, height: verified.video.height, encoder: rendered.encoder, bytes: rendered.bytes });
    console.log(`Verified ${format}: ${verified.video.width}x${verified.video.height}, ${verified.duration}s, ${rendered.encoder}`);
  }
  report.checks.push('four real renders decode, including 4K, speed changes, filmlook, captions, ducked looped music');
  report.checks.push('crop, zoom, focus, mirror, channel fix and delayed/trimmed non-looping narration render successfully');
  const exportedFrame = (await callAgentTool('studio_frame', { projectId: id, exportId: project.exports.at(-1).id, time: 2 }, api)).frame;
  assert.match(exportedFrame.note, /Finished export/); report.reviewFrame = exportedFrame.file;
  await assert.rejects(() => callAgentTool('studio_frame', { projectId: id, exportId: '00000000-0000-0000-0000-000000000000', time: 1 }, api));
  report.checks.push('finished export frame available for agent visual review; unregistered exports rejected');
  assert.equal(await hashFile(fixture), before); report.checks.push('original SHA256 unchanged');
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'mcp.mjs')], { cwd: PROJECT_ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', serial = 0; const pending = new Map();
  child.stdout.on('data', chunk => {
    buffer += chunk; let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try { const data = JSON.parse(line); pending.get(data.id)?.(data); pending.delete(data.id); } catch (e) { report.protocolError = e.message; }
    }
  });
  function rpc(method, params) { return new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 30000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  }); }
  try {
    assert.equal((await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'qa', version: '1' } })).result.protocolVersion, '2025-06-18');
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    assert.equal((await rpc('tools/list', {})).result.tools.length, 56);
    assert.equal((await rpc('tools/call', { name: 'studio_get', arguments: { projectId: id } })).result.isError, false);
    const visual = await rpc('tools/call', { name: 'studio_frame', arguments: { projectId: id, sourceIndex: 0, time: 1 } });
    assert.equal(visual.result.content[1].type, 'image');
    assert.equal((await rpc('tools/call', { name: 'studio_get', arguments: { projectId: '../invalid' } })).result.isError, true);
    assert.equal((await rpc('unknown/method', {})).error.code, -32601); assert.equal(report.protocolError, undefined);
    report.checks.push('MCP initialization, discovery, read, real image, error boundaries and clean JSON-RPC stdout');
    // Director 0.4 agent tools over the same MCP transport.
    const text = r => JSON.parse(r.result.content[0].text);
    const tl = text(await rpc('tools/call', { name: 'studio_timeline', arguments: { projectId: id } }));
    assert.ok(tl.timeline.clips.length >= 1 && tl.timeline.clips[0].id);
    const board = await rpc('tools/call', { name: 'studio_storyboard', arguments: { projectId: id } });
    assert.equal(board.result.content[1].type, 'image');
    const rev = tl.timeline.revision, firstId = tl.timeline.clips[0].id;
    const dry = text(await rpc('tools/call', { name: 'studio_edit', arguments: { projectId: id, revision: rev, dryRun: true, operations: [{ op: 'set', clip: firstId, label: 'qa' }] } }));
    assert.equal(dry.dryRun, true); assert.equal(dry.diff.changed[0].id, firstId);
    const edited = text(await rpc('tools/call', { name: 'studio_edit', arguments: { projectId: id, revision: rev, summary: 'QA label', operations: [{ op: 'set', clip: firstId, label: 'qa' }] } }));
    assert.equal(edited.project.revision, rev + 1); assert.equal(edited.project.lastChange.author, 'agent');
    const bad = await rpc('tools/call', { name: 'studio_edit', arguments: { projectId: id, revision: rev, operations: [{ op: 'set', clip: firstId, label: 'stale' }] } });
    assert.equal(bad.result.isError, true);
    assert.ok(text(await rpc('tools/call', { name: 'studio_review', arguments: { projectId: id } })).review.score >= 0);
    assert.ok(text(await rpc('tools/call', { name: 'studio_history', arguments: { projectId: id } })).history.some(h => h.summary === 'QA label'));
    const restored = text(await rpc('tools/call', { name: 'studio_restore', arguments: { projectId: id, revision: rev + 1, toRevision: rev } }));
    assert.equal(restored.project.revision, rev + 2);
    report.checks.push('0.4 agent tools: timeline, storyboard image, dry-run + atomic edit with author, stale revision rejected, review, history and non-destructive restore');
  } finally { child.stdin.end(); child.kill(); }
  // Director 0.4.1: still image source, transitions, per-clip colour, timeline texts, HTTP tool door, duplicate.
  const still = path.join(output, 'card.png');
  await runProcess(tools.ffmpeg, ['-hide_banner', '-nostdin', '-n', '-f', 'lavfi', '-i', 'color=c=0x334455:s=640x360:d=1', '-frames:v', '1', still], { timeoutMs: 60000 });
  const httpBase = base.replace(/\/api$/, '');
  const http = async (name, args) => { const r = await fetch(`${httpBase}/api/agent/tools/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Client': 'qa-http' }, body: JSON.stringify(args) }); const v = await r.json(); if (!r.ok) throw new Error(v.error?.message); return v.result; };
  const schema = await (await fetch(`${httpBase}/api/openapi.json`)).json();
  assert.equal(schema.openapi, '3.1.0'); assert.ok(schema.paths['/api/agent/tools/studio_edit']);
  let mixed = (await http('studio_create', { name: 'QA transitions', inputs: [still, fixture], options: { duration: 8, label: '', endTitle: '', fadeOut: 0 } })).project;
  await http('studio_analyze', { projectId: mixed.id, revision: mixed.revision }); mixed = await wait(mixed.id);
  assert.ok(mixed.plan.clips.every(c => c.sourceIndex === 1), 'proposal never uses the still');
  const edited = await http('studio_edit', { projectId: mixed.id, revision: mixed.revision, summary: 'QA transitions', operations: [
    { op: 'replace', clips: [{ sourceIndex: 0, start: 0, end: 2 }, { sourceIndex: 1, start: 0, end: 3, transition: 'fade', transitionSeconds: 0.8, saturation: 1.3, temperature: 0.4 }, { sourceIndex: 1, start: 5, end: 8, transition: 'fadeblack', transitionSeconds: 0.5, framing: 'fill', zoom: 1.2, sharpen: 0.5 }] },
    { op: 'add_text', start: 0.2, end: 1.8, text: 'QA title card', style: 'big' }, { op: 'add_text', start: 3, end: 6, text: 'Lower third', style: 'lower' }] });
  assert.equal(edited.project.lastChange.author, 'qa-http'); assert.equal(edited.project.plan.actualDuration, 6.7);
  await http('studio_render', { projectId: mixed.id, revision: edited.project.revision, preview: true }); mixed = await wait(mixed.id);
  const tr = mixed.exports.at(-1); const trInfo = await verifyVideo(tr.output, tools);
  assert.ok(Math.abs(trInfo.duration - 6.7) < 0.2, `transition render duration ${trInfo.duration}`);
  const board = await http('studio_storyboard', { projectId: mixed.id, exportId: tr.id, count: 6 }); assert.ok(board.storyboard.imageBase64.length > 1000);
  const copy = (await http('studio_duplicate', { projectId: mixed.id, name: 'QA copy' })).project;
  assert.equal(copy.revision, 1); assert.equal(copy.plan.clipCount, 3); assert.equal(copy.exports.length, 0); assert.notEqual(copy.id, mixed.id);
  report.outputs.push({ format: 'transitions-preview', file: tr.output, width: trInfo.video.width, height: trInfo.video.height, duration: trInfo.duration });
  report.checks.push('0.4.1: still image source, xfade transitions shorten the edit as computed, per-clip colour, timeline texts, HTTP tool door with OpenAPI and author attribution, export storyboard, duplicate');
  const cli = await runProcess(process.execPath, ['cli.mjs', 'studio', 'get', '--project', id], { cwd: PROJECT_ROOT, timeoutMs: 30000 });
  assert.equal(JSON.parse(cli.stdout).project.id, id); report.checks.push('headless CLI gets same daemon project without duplicate server');
  report.passed = true;
} catch (e) { report.passed = false; report.failure = e.stack; process.exitCode = 1; }
finally { report.completedAt = new Date().toISOString(); await fs.writeFile(path.join(output, 'director-verification.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
