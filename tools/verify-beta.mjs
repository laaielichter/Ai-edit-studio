import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';
import { findFfmpegTools, probeMedia, verifyVideo } from '../src/ffmpeg.mjs';
import { runProcess } from '../src/process.mjs';
import { hashFile, ensureDataRoot, DATA_ROOT, safeResolveWithin } from '../src/paths.mjs';

const output = process.argv[2];
if (!output) throw new Error('Usage: node tools/verify-beta.mjs <new-QA-directory-under-data-root>');
safeResolveWithin(DATA_ROOT, path.relative(DATA_ROOT, path.resolve(output)));
await ensureDataRoot(1024 ** 3); await fs.mkdir(output, { recursive: false });
const tools = findFfmpegTools(); const base = `http://127.0.0.1:${process.env.GAME_TRAILER_STUDIO_PORT || 32146}`;
const report = { startedAt: new Date().toISOString(), checks: [], errors: [], originalMediaModified: false };
async function call(url, method = 'GET', data) {
  const r = await fetch(base + url, { method, headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  const value = await r.json(); if (!r.ok) throw new Error(value.error?.message); return value;
}
try {
  const fixture = path.join(output, 'source.mp4'), logo = path.join(output, 'logo.png'), music = path.join(output, 'music.wav');
  await runProcess(tools.ffmpeg, ['-hide_banner', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=180:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-c:a', 'aac', fixture], { timeoutMs: 60000 });
  await runProcess(tools.ffmpeg, ['-hide_banner', '-nostdin', '-n', '-f', 'lavfi', '-i', 'color=c=yellow:s=64x32', '-frames:v', '1', logo], { timeoutMs: 60000 });
  await runProcess(tools.ffmpeg, ['-hide_banner', '-nostdin', '-n', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'pcm_s16le', music], { timeoutMs: 60000 });
  const before = await hashFile(fixture);
  let requests = 0;
  const observer = http.createServer((req, res) => { requests++; res.writeHead(404); res.end(); });
  await new Promise(resolve => observer.listen(0, '127.0.0.1', resolve));
  try {
    const disguised = path.join(output, 'network-playlist.mp4');
    await fs.writeFile(disguised, `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nhttp://127.0.0.1:${observer.address().port}/segment.ts\n#EXT-X-ENDLIST\n`);
    await assert.rejects(() => probeMedia(disguised, tools));
    assert.equal(requests, 0); report.checks.push('disguised network playlist cannot make HTTP requests');
  } finally { await new Promise(resolve => observer.close(resolve)); }
  const request = { name: 'QA — short audio + logo', input: fixture,
    options: { duration: 5, style: 'flight', gameGain: 1, musicGain: 0.1, music, logo, title: 'BETA / AUDIO & LOGO', label: 'SYNTHETIC TEST FOOTAGE' } };
  const { project } = await call('/api/studio/projects', 'POST', request);
  report.projectId = project.id; const endpoint = `/api/studio/projects/${project.id}`;
  await call(endpoint + '/replan', 'POST', {});
  let state = (await call(endpoint)).project;
  const beforeRevision = state.revision;
  const rejected = await fetch(base + endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: beforeRevision, clips: [{ sourceIndex: 0, start: 0, end: 4 }, { sourceIndex: 0, start: 3, end: 5 }] }) });
  assert.equal(rejected.status, 400); assert.equal((await call(endpoint)).project.revision, beforeRevision);
  report.checks.push('overlapping edit rejected without changing saved project');
  const conflict = await fetch(base + endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: -1 }) });
  assert.equal(conflict.status, 409); report.checks.push('stale revisions rejected with HTTP 409');
  const crossSite = await fetch(base + '/api/studio/projects', { headers: { Origin: 'https://untrusted.example' } });
  assert.equal(crossSite.status, 403); report.checks.push('cross-origin project access rejected');
  const blob = await fs.readFile(logo);
  const uploads = [];
  for (let i = 0; i < 2; i++) {
    const r = await fetch(base + '/api/studio/import?name=logo.png', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
    assert.equal(r.status, 201); uploads.push((await r.json()).imported.path);
  }
  assert.equal(uploads[0], uploads[1]); assert.equal(await hashFile(uploads[0]), await hashFile(logo));
  report.checks.push('local drag-import deduplicates identical payloads');
  await call(endpoint + '/export', 'POST', { formats: ['whatsapp'] });
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    state = (await call(endpoint)).project;
    if (!['rendering', 'previewing'].includes(state.status)) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  assert.equal(state.status, 'ready', state.errorDetail || state.message);
  const rendered = state.exports.at(-1); assert.ok(rendered.bytes < 16 * 1024 ** 2);
  const info = await verifyVideo(rendered.output, tools);
  assert.ok(Math.abs(info.duration - 5) < 0.1); assert.ok(info.audio); assert.equal(info.video.width, 1280);
  report.checks.push('looping music, logo and short game audio produce fully decodable 5s MP4');
  const range = await fetch(base + endpoint + `/media/export/${rendered.id}`, { headers: { Range: 'bytes=0-31' } });
  assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 32);
  const invalid = await fetch(base + endpoint + `/media/export/${rendered.id}`, { headers: { Range: 'bytes=999999999999-' } });
  assert.equal(invalid.status, 416); report.checks.push('video range requests support seeking and reject invalid ranges');
  assert.equal(await hashFile(fixture), before); report.checks.push('original fixture SHA256 unchanged');
  report.outputs = [{ file: rendered.output, sha256: await hashFile(rendered.output), bytes: rendered.bytes }];
  report.passed = true;
} catch (e) {
  report.passed = false; report.errors.push(e.message); process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  await fs.writeFile(path.join(output, 'beta-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
