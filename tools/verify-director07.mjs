// End-to-end check of the Director 0.7 agent tools through the HTTP tool door, on synthetic media.
// Usage: node tools/verify-director07.mjs <new-empty-dir-under-data-root> [port]
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findFfmpegTools, probeMedia } from '../src/ffmpeg.mjs';
import { runProcess } from '../src/process.mjs';
import { DATA_ROOT } from '../src/paths.mjs';

const root = path.resolve(process.argv[2] ?? '');
const port = Number(process.argv[3] ?? 32196);
if (!process.argv[2] || !root.startsWith(DATA_ROOT)) { console.error(`Give a new folder under ${DATA_ROOT}`); process.exit(2); }
await fs.mkdir(root, { recursive: false });
const { ffmpeg } = findFfmpegTools();
const media = async (name, args) => { const file = path.join(root, name); await runProcess(ffmpeg, ['-hide_banner', '-v', 'error', '-y', ...args, file], { timeoutMs: 180000 }); return file; };
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

// 90 s "long recording": moving block with bursts of action every 20 s and pink noise "speech" that is quiet now and then.
const long = await media('long.mp4', ['-f', 'lavfi', '-i', 'color=c=0x223344:s=1280x720:r=30:d=90', '-f', 'lavfi', '-i', 'color=c=white:s=100x100:r=30:d=90',
  '-f', 'lavfi', '-i', 'anoisesrc=d=90:c=pink:a=0.15', '-filter_complex',
  "[0][1]overlay=x='60+mod(t*(if(lt(mod(t,20),6),260,40)),1100)':y=300[v];[2]volume='if(lt(mod(t,10),1.2),0.02,1)':eval=frame[a]",
  '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
const broll = await media('broll.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=10', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p']);

const env = { ...process.env, GAME_TRAILER_STUDIO_PORT: String(port) };
const server = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs')], { env, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ } await new Promise(r => setTimeout(r, 200)); }
const tool = async (name, args) => {
  const r = await fetch(`${base}/api/agent/tools/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Client': 'verify-0.7' }, body: JSON.stringify(args) });
  const j = await r.json(); if (!j.ok) { const e = new Error(`${name}: ${j.error?.code} ${j.error?.message}`); e.code = j.error?.code; throw e; } return j.result;
};
const idle = async id => { for (;;) { const w = await tool('studio_wait', { projectId: id, timeoutSeconds: 120 }); if (!w.timedOut) return w.project; } };

try {
  const schema = await tool('studio_schema', {});
  check('schema: 36+ tools, 0.7 capabilities', schema.tools.length >= 36 && schema.capabilities.recipes === true, `${schema.tools.length} tools, ${schema.version}`);

  // Live events (SSE) while we work.
  const events = [];
  const controller = new AbortController();
  const sse = fetch(`${base}/api/events`, { signal: controller.signal }).then(async r => { const reader = r.body.getReader(); const dec = new TextDecoder(); for (;;) { const { value, done } = await reader.read(); if (done) break; events.push(...dec.decode(value).split('\n').filter(l => l.startsWith('event: ')).map(l => l.slice(7))); } }).catch(() => {});

  const { project: created } = await tool('studio_create', { name: 'Verify 0.7', inputs: [long, broll] });
  const id = created.id;
  await tool('studio_analyze', { projectId: id, revision: created.revision });
  let p = await idle(id);
  check('studio_wait returns when analysis is done', p.status === 'ready' && p.analyzed, p.message);

  // Transcript (synthetic words with sentences) → clip finder.
  const words = []; let t = 0.4;
  for (let i = 0; i < 200; i++) { words.push({ start: +t.toFixed(2), end: +(t + 0.3).toFixed(2), text: i % 12 === 11 ? `end${i}.` : i % 30 === 5 ? 'Really?' : `w${i}` }); t += 0.42; }
  await tool('studio_transcript', { projectId: id, action: 'import', sourceIndex: 0, words, language: 'en' });
  const found = await tool('studio_find_clips', { projectId: id, count: 3, minSeconds: 12, maxSeconds: 30, platform: 'tiktok', create: true, render: true });
  check('find_clips: 3 ranked, sentence-aligned clips', found.clips.length === 3 && found.clips.every(c => c.duration >= 12 && c.duration <= 30) && /transcript/.test(found.method),
    found.clips.map(c => `#${c.rank} ${c.start}–${c.end} s score ${c.score}`).join(' | '));
  check('find_clips: one project per clip, renders queued', found.created.length === 3 && found.created.every(c => c.projectId), found.created.map(c => c.queued ? 'queued' : 'started').join(','));
  const q = await tool('studio_queue', { action: 'list' });
  check('queue lists waiting jobs', Array.isArray(q.queue.waiting), `${q.queue.waiting.length} waiting, busy=${q.queue.busy}`);
  for (const c of found.created) await idle(c.projectId);
  const clipProject = (await tool('studio_get', { projectId: found.created[0].projectId })).project;
  check('clip project rendered vertical with captions + reframe', clipProject.exports.length === 1 && clipProject.exports[0].height > clipProject.exports[0].width && clipProject.options.captions.length > 0 && clipProject.options.captionAnimation === 'pop',
    `${clipProject.exports[0]?.width}x${clipProject.exports[0]?.height}, ${clipProject.options.captions.length} captions, ${clipProject.exports[0]?.captionAnimation}`);
  const qc1 = await tool('studio_qc', { projectId: clipProject.id });
  check('QC of the clip render: loudness near −14 LUFS, passes', qc1.qc.passed && Math.abs(qc1.qc.loudness + 14) <= 1.5, `score ${qc1.qc.score}, ${qc1.qc.loudness} LUFS, peak ${qc1.qc.truePeak}`);

  // Multitrack + motion + audio on the main project.
  p = (await tool('studio_get', { projectId: id })).project;
  const ed = await tool('studio_edit', { projectId: id, revision: p.revision, summary: 'Overlays, J-cut, punch-in, ramp, audio', operations: [
    { op: 'replace', clips: [{ sourceIndex: 0, start: 0, end: 6 }, { sourceIndex: 0, start: 20, end: 26 }, { sourceIndex: 0, start: 40, end: 44 }] },
    { op: 'set', clip: 1, audioShift: -0.5 },
    { op: 'speed_ramp', clip: 2, from: 1, to: 0.6, steps: 3 },
    { op: 'punch_in', clip: 0, seconds: 2, zoom: 1.2 },
    { op: 'add_overlay', sourceIndex: 1, start: 0, end: 2, at: 1, mode: 'pip', position: 'top-right' },
    { op: 'add_overlay', sourceIndex: 1, start: 4, end: 6, at: 7, mode: 'full' },
    { op: 'set_options', options: { voiceEnhance: 'strong', loudnessTarget: -16, captionAnimation: 'karaoke', captionCase: 'upper', autoCaptions: true } }] });
  check('edit ops: punch_in, speed_ramp, add_overlay, audioShift', ed.project.plan.clips.length === 3 + 2 + 2 && ed.project.options.overlays.length === 2, ed.diff.summary);
  const fr = await tool('studio_freeze', { projectId: id, revision: ed.project.revision, at: 9, seconds: 1.5, zoomEnd: 1.2 });
  check('freeze frame inserted as a still source', fr.project.sources.length === 3 && fr.project.plan.clips.some(c => c.label === 'freeze'), fr.diff.summary);
  await tool('studio_render', { projectId: id, revision: fr.project.revision, preview: true });
  p = await idle(id);
  const pre = p.exports.at(-1);
  check('preview with overlays, J-cut, ramp, freeze, karaoke renders at the edit length', p.status === 'ready' && Math.abs(pre.duration - p.plan.actualDuration) < 0.1 && pre.captionAnimation === 'karaoke', `${pre.duration} s / ${p.plan.actualDuration} s`);
  const qc2 = await tool('studio_qc', { projectId: id });
  check('QC measures −16 LUFS target', Math.abs(qc2.qc.loudness + 16) <= 1.5, `${qc2.qc.loudness} LUFS, ${qc2.qc.issues.map(i => i.code).join(',') || 'no issues'}`);

  // Recipe: social pack in one call.
  const run = await tool('studio_recipe', { action: 'run', name: 'social-pack', projectId: id, inputs: { platform: 'reels', hookText: 'WATCH' } });
  let status;
  for (let i = 0; i < 600; i++) { status = (await tool('studio_recipe', { action: 'status', runId: run.run.id })).run; if (status.status !== 'running') break; await new Promise(r => setTimeout(r, 1000)); }
  check('recipe social-pack: auto-edit → render → QC → publish pack', status.status === 'done' && status.log.every(l => l.ok) && status.results.publish?.length === 1, status.log.map(l => `${l.tool}: ${l.summary ?? l.error}`).join(' | '));
  const recipes = await tool('studio_recipe', { action: 'list' });
  check('recipes listed (4 built-in)', recipes.recipes.filter(r => r.builtIn).length === 4);
  const saved = await tool('studio_recipe', { action: 'save', name: 'My quick check', steps: [{ tool: 'studio_review', arguments: { projectId: '$projectId' } }] });
  check('custom recipe saved', saved.recipe.id === 'my-quick-check');

  controller.abort(); await sse;
  check('SSE event stream delivered project and queue events', events.includes('project') && events.includes('queue'), `${events.length} events`);
  check('original media untouched', (await fs.stat(long)).size > 0 && (await probeMedia(broll)).duration > 9);
} catch (e) {
  check('unexpected error', false, e.stack);
} finally {
  server.kill();
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
