// End-to-end check of the Director 0.6 agent tools through the HTTP tool door.
// Usage: node tools/verify-director06.mjs <new-empty-dir-under-data-root> [port]
// Creates synthetic media (no originals touched), starts a server, runs every new tool, renders.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findFfmpegTools, probeMedia } from '../src/ffmpeg.mjs';
import { runProcess } from '../src/process.mjs';
import { DATA_ROOT } from '../src/paths.mjs';

const root = path.resolve(process.argv[2] ?? '');
const port = Number(process.argv[3] ?? 32198);
if (!process.argv[2] || !root.startsWith(DATA_ROOT)) { console.error(`Give a new folder under ${DATA_ROOT}`); process.exit(2); }
await fs.mkdir(root, { recursive: false });
const { ffmpeg } = findFfmpegTools();
const media = async (name, args) => { const file = path.join(root, name); await runProcess(ffmpeg, ['-hide_banner', '-v', 'error', '-y', ...args, file], { timeoutMs: 120000 }); return file; };
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

// 30 s 16:9 "action" clip: a bright block crossing the frame, scene change at 12 s, a frozen+silent stretch 20–25 s.
const action = await media('action.mp4', ['-f', 'lavfi', '-i', 'color=c=0x223344:s=1280x720:r=30:d=30', '-f', 'lavfi', '-i', 'color=c=white:s=120x120:r=30:d=30',
  '-f', 'lavfi', '-i', 'anoisesrc=d=30:c=pink:a=0.2', '-filter_complex',
  "[0][1]overlay=x='if(lt(t,20),60+mod(t,12)*90,1100)':y=300,eq=brightness='if(between(t,12,20),0.15,0)'[v];[2]volume='if(between(t,20,25),0,1)':eval=frame[a]",
  '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
const intro = await media('intro.mp4', ['-f', 'lavfi', '-i', 'color=c=0xFFB400:s=640x360:r=30:d=1.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
const logo = await media('logo.png', ['-f', 'lavfi', '-i', 'color=c=0xFF0055:s=200x80', '-frames:v', '1']);

const env = { ...process.env, GAME_TRAILER_STUDIO_PORT: String(port) };
const server = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs')], { env, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ } await new Promise(r => setTimeout(r, 200)); }
const tool = async (name, args) => {
  const r = await fetch(`${base}/api/agent/tools/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Client': 'verify-0.6' }, body: JSON.stringify(args) });
  const j = await r.json(); if (!j.ok) { const e = new Error(`${name}: ${j.error?.code} ${j.error?.message}`); e.code = j.error?.code; throw e; } return j.result;
};
const wait = async id => { for (;;) { const { project } = await tool('studio_get', { projectId: id }); if (!['analyzing', 'rendering', 'previewing'].includes(project.status)) return project; await new Promise(r => setTimeout(r, 500)); } };

try {
  const schema = await tool('studio_schema', {});
  check('schema lists the 0.6 tools', schema.tools.length >= 30 && schema.tools.some(t => t.name === 'studio_auto_edit'), `${schema.tools.length} tools, ${schema.version}`);
  const { project: created } = await tool('studio_create', { name: 'Verify 0.6', inputs: [action] });
  const id = created.id;

  // Director mode.
  await tool('studio_auto_edit', { projectId: id, platform: 'tiktok', hookText: 'WATCH', cta: 'Follow', preview: true });
  let p = await wait(id);
  const a = p.autoEdit;
  check('auto_edit finished with a preview', p.status === 'ready' && a?.exports?.length === 1, p.message);
  check('auto_edit skipped the frozen+silent stretch', p.plan.clips.every(c => c.end <= 20.8 || c.start >= 24.2), a.steps.join(' | '));
  check('auto_edit picked a hook and reframed for 9:16', a.hook >= 50 && a.steps.some(s => s.startsWith('reframed')), `hook ${a.hook}, ${a.shots} shots, ${a.duration}s`);
  const prev = await probeMedia(a.exports[0].output);
  check('auto_edit preview is vertical', prev.video.height > prev.video.width, `${prev.video.width}x${prev.video.height}`);
  check('auto_edit revisions are in history', (await tool('studio_history', { projectId: id })).history.length >= 3);

  // Reframe tool (dry run on current edit) and a panning shot on the moving block.
  const rf = await tool('studio_reframe', { projectId: id, revision: p.revision, aspect: '1:1', dryRun: true });
  check('reframe dry run', rf.dryRun === true && rf.reframed >= 1, `${rf.reframed} shots, ${rf.panning} panning`);

  // Transcript import → read → text edit → paper edit.
  const words = [];
  let t = 0.5;
  for (let i = 0; i < 40; i++) { if (i === 20) t += 2.5; words.push({ start: Number(t.toFixed(2)), end: Number((t + 0.3).toFixed(2)), text: i % 9 === 4 ? 'um' : `word${i}` }); t += 0.4; }
  const imp = await tool('studio_transcript', { projectId: id, action: 'import', sourceIndex: 0, words, language: 'en' });
  check('transcript import (words array)', imp.words === 40);
  const tr = await tool('studio_transcript', { projectId: id, sourceIndex: 0 });
  check('transcript read: fillers, pauses, stamps', tr.transcript.fillers === 4 && tr.transcript.longPauses === 1 && /#0\]/.test(tr.transcript.text), `${tr.transcript.fillers} fillers, ${tr.transcript.longPauses} pauses`);
  p = (await tool('studio_get', { projectId: id })).project;
  // Restore a long chronological edit so the words are in it.
  await tool('studio_edit', { projectId: id, revision: p.revision, operations: [{ op: 'replace', clips: [{ sourceIndex: 0, start: 0, end: 20 }] }] });
  p = (await tool('studio_get', { projectId: id })).project;
  const dry = await tool('studio_text_edit', { projectId: id, revision: p.revision, removeFillers: true, removePauses: { min: 1.5 }, dryRun: true });
  check('text_edit dry run', dry.dryRun === true && dry.stats.fillers === 4 && dry.stats.pauses === 1, JSON.stringify(dry.stats));
  const te = await tool('studio_text_edit', { projectId: id, revision: p.revision, removeFillers: true, removePauses: { min: 1.5 }, removeText: ['word32 word33'] });
  check('text_edit applied as revision', te.project.revision === p.revision + 1 && te.project.plan.clips.length >= 5 && te.stats.phrases === 1, te.diff.summary);
  check('captions follow the transcript', te.project.options.autoCaptions === true && te.project.options.captions.length > 0 && !te.project.options.captions.some(c => /\bum\b|word32|word33/.test(c.text)), `${te.project.options.captions.length} cues`);
  const paper = await tool('studio_text_edit', { projectId: id, revision: te.project.revision, assemble: [{ from: 30, to: 35, label: 'Punchline' }, { from: 0, to: 3, label: 'Setup' }] });
  check('paper edit (assemble) builds the timeline from word ranges', paper.project.plan.clips.length === 2 && paper.project.plan.clips[0].label === 'Punchline', paper.diff.summary);

  // Brand kit with intro, logo and colours → preview render includes the intro.
  const brand = await tool('studio_brand', { action: 'save', name: 'Verify Brand', logo, intro, primary: '#112233', accent: '#FFB400', logoPosition: 'top-right', cta: 'Wishlist now', hashtags: ['indiegame'] });
  check('brand save', brand.brand.id === 'verify-brand');
  const applied = await tool('studio_brand', { action: 'apply', name: 'Verify Brand', projectId: id, revision: paper.project.revision });
  check('brand apply sets options', applied.project.options.brand === 'verify-brand' && applied.project.options.endTitle === 'Wishlist now');
  await tool('studio_render', { projectId: id, revision: applied.project.revision, preview: true, previewFormat: 'vertical' });
  p = await wait(id);
  const branded = p.exports.at(-1);
  check('branded preview renders with intro', p.status === 'ready' && Math.abs(branded.duration - (p.plan.actualDuration + 1.5)) < 0.25 && branded.introSeconds === 1.5, `${branded.duration}s for ${p.plan.actualDuration}s + intro`);

  // Publish pack.
  const pack = await tool('studio_publish_pack', { projectId: id, title: 'Verify launch', platforms: ['youtube', 'tiktok', 'x'] });
  const kinds = pack.publish.files.map(f => f.kind);
  check('publish pack files', ['thumbnail', 'cover', 'still', 'captions', 'notes'].every(k => kinds.includes(k)), kinds.join(','));
  for (const f of pack.publish.files.filter(f => f.kind === 'thumbnail' || f.kind === 'cover').slice(0, 2)) {
    const info = await probeMedia(f.file);
    check(`${f.kind} size`, f.kind === 'thumbnail' ? info.video.width === 1280 && info.video.height === 720 : info.video.width === 1080 && info.video.height === 1920, `${info.video.width}x${info.video.height}`);
  }
  check('publish drafts include brand hashtag and CTA', pack.publish.drafts.tiktok.description.includes('#indiegame') && pack.publish.drafts.youtube.description.includes('Wishlist now'));

  // Speech engine: either transcribes, or explains how to install it.
  const doctor = await tool('studio_doctor', {});
  if (doctor.dependencies?.speech?.ok) {
    await tool('studio_transcribe', { projectId: id, sourceIndex: 0, captions: false });
    p = await wait(id);
    check('transcribe with local engine', p.status === 'ready', p.message);
  } else {
    let message = '';
    try { await tool('studio_transcribe', { projectId: id, sourceIndex: 0 }); } catch (e) { message = e.message; }
    check('transcribe explains setup when no engine is installed', /ASR_UNAVAILABLE/.test(message) && /speech-setup/.test(message), message.slice(0, 120));
  }
  check('original media untouched', (await fs.stat(action)).size > 0);
} catch (e) {
  check('unexpected error', false, e.stack);
} finally {
  server.kill();
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
