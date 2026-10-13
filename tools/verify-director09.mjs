// End-to-end check of the Director 0.9 tools through the HTTP tool door: LUTs, colour match, stabilisation,
// music to length, audio repair, sound effects, emphasis zooms, automatic B-roll, stems, compare, batch.
// Usage: node tools/verify-director09.mjs <new-empty-dir-under-data-root> [port]
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findFfmpegTools, probeMedia, probeAudio } from '../src/ffmpeg.mjs';
import { runProcess } from '../src/process.mjs';
import { DATA_ROOT } from '../src/paths.mjs';
import { cubeText } from '../src/polish.mjs';

const root = path.resolve(process.argv[2] ?? '');
const port = Number(process.argv[3] ?? 32195);
if (!process.argv[2] || !root.startsWith(DATA_ROOT)) { console.error(`Give a new folder under ${DATA_ROOT}`); process.exit(2); }
await fs.mkdir(root, { recursive: false });
const { ffmpeg } = findFfmpegTools();
const media = async (name, args) => { const file = path.join(root, name); await runProcess(ffmpeg, ['-hide_banner', '-v', 'error', '-y', ...args, file], { timeoutMs: 180000 }); return file; };
const hash = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const bandDb = async (file, f, seconds = 20) => {
  const r = await runProcess(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'info', '-t', String(seconds), '-i', file, '-vn', '-af', `bandpass=f=${f}:width_type=q:w=12,bandpass=f=${f}:width_type=q:w=12,astats=measure_perchannel=none`, '-f', 'null', '-'], { timeoutMs: 120000 });
  return Number(`${r.stderr}`.match(/RMS level dB:\s*(-?[\d.]+)/)?.[1]);
};

// A talking-head recording with mains hum (50 Hz) and a shaky second camera with a warm, dark cast.
const voice = "aevalsrc='0.35*sin(2*PI*180*t)*(0.6+0.4*sin(2*PI*3*t))*gt(sin(2*PI*0.4*t),-0.3)':d=40:s=48000";
const talk = await media('talk.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=40', '-f', 'lavfi', '-i', voice, '-f', 'lavfi', '-i', 'sine=f=50:d=40',
  '-filter_complex', '[2:a]volume=0.12[h];[1:a][h]amix=inputs=2:normalize=0[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-shortest']);
const shaky = await media('cam-b warm.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=720x405:r=30:d=30', '-f', 'lavfi', '-i', 'anoisesrc=d=30:c=pink:a=0.05',
  '-vf', "crop=640:360:x='40+30*sin(t*7)+18*sin(t*13)':y='22+16*sin(t*9)',colortemperature=temperature=3800,eq=brightness=-0.12", '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
const broll = await media('rocket launch.mp4', ['-f', 'lavfi', '-i', 'mandelbrot=s=640x360:r=30', '-t', '15', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p']);
const music = await media('track.wav', ['-f', 'lavfi', '-i', "aevalsrc='0.6*sin(2*PI*55*t)*exp(-18*mod(t,0.5))+0.15*sin(2*PI*440*t)*lt(t,56)+0.3*sin(2*PI*220*t)*gte(t,56)*exp(-(t-56))':d=60:s=48000"]);
const cube = path.join(root, 'My Look.cube'); await fs.writeFile(cube, cubeText('warm-film', 9), 'utf8');
const originals = Object.fromEntries(await Promise.all([talk, shaky, broll, music, cube].map(async f => [f, await hash(f)])));

const env = { ...process.env, GAME_TRAILER_STUDIO_PORT: String(port) };
const server = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs')], { env, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ } await new Promise(r => setTimeout(r, 200)); }
const tool = async (name, args) => {
  const r = await fetch(`${base}/api/agent/tools/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Client': 'verify-0.9' }, body: JSON.stringify(args) });
  const j = await r.json(); if (!j.ok) { const e = new Error(`${name}: ${j.error?.code} ${j.error?.message}`); e.code = j.error?.code; throw e; } return j.result;
};
const idle = async id => (await tool('studio_wait', { projectId: id, timeoutSeconds: 280 })).project;
const get = async id => (await tool('studio_get', { projectId: id })).project;
const lastFilter = async (id, stage = 'preview-filter.txt') => {
  const dir = path.join(DATA_ROOT, 'studio', 'projects', id, 'renders'); const runs = await fs.readdir(dir).catch(() => []);
  const stats = await Promise.all(runs.map(async r => ({ r, t: (await fs.stat(path.join(dir, r))).mtimeMs }))); stats.sort((a, b) => b.t - a.t);
  for (const { r } of stats) { const f = path.join(dir, r, 'tmp', stage); try { return await fs.readFile(f, 'utf8'); } catch { /* next */ } }
  return '';
};

try {
  const schema = await tool('studio_schema', {});
  const names = ['lut', 'color_match', 'stabilize', 'music_fit', 'audio_repair', 'sfx', 'auto_zoom', 'auto_broll', 'batch', 'compare'].map(n => `studio_${n}`);
  check('schema lists the ten 0.9 tools', names.every(n => schema.tools.some(t => t.name === n)) && schema.version.startsWith('0.9'), `${schema.tools.length} tools, ${schema.version}`);
  const RUN = Date.now().toString(36);
  const { project: created } = await tool('studio_create', { name: `Verify 0.9 talk ${RUN}`, inputs: [talk, shaky, broll], options: { label: '', endTitle: '', fadeIn: 0, fadeOut: 0.3 } });
  const id = created.id;
  await tool('studio_analyze', { projectId: id, revision: created.revision });
  let p = await idle(id);
  // A clean edit: talk 0–20 in two shots, the shaky warm camera 5–11, talk 24–30.
  let ed = await tool('studio_edit', { projectId: id, revision: p.revision, operations: [{ op: 'replace', clips: [{ sourceIndex: 0, start: 0, end: 9 }, { sourceIndex: 0, start: 9, end: 18 }, { sourceIndex: 1, start: 5, end: 11 }, { sourceIndex: 0, start: 24, end: 30, transition: 'fade', transitionSeconds: 0.5 }] },
    { op: 'set_options', options: { allowJumpCuts: true } }] });
  p = ed.project;
  const words = []; let t = 0.4;
  const said = 'welcome back today we talk about the rocket we built ! it flies higher than ever . what do you think ? next week we launch it again'.split(' ');
  said.forEach((w, i) => { if (['!', '.', '?'].includes(w)) { words.at(-1).text += w; return; } words.push({ start: +t.toFixed(2), end: +(t + 0.35).toFixed(2), text: w }); t += i % 6 === 5 ? 1.2 : 0.55; });
  await tool('studio_transcript', { projectId: id, action: 'import', sourceIndex: 0, words, language: 'en' });

  // 1. LUTs.
  const lib = await tool('studio_lut', { action: 'list' });
  check('built-in LUT library', lib.luts.filter(l => l.builtin).length === 6, lib.luts.map(l => l.id).join(', '));
  const imp = await tool('studio_lut', { action: 'import', file: cube });
  check('LUT import copies into the library', imp.imported.id.startsWith('my look') && imp.imported.file !== cube);
  p = await get(id);
  const applied = await tool('studio_lut', { projectId: id, action: 'apply', name: 'teal-orange', strength: 0.7, revision: p.revision });
  check('LUT applied as a revision', /builtin-teal-orange\.cube$/.test(applied.project.options.lut) && applied.project.options.lutStrength === 0.7);
  const prev = await tool('studio_lut', { projectId: id, action: 'preview', time: 3 });
  check('LUT before/after preview image', prev.frame?.imageBase64?.length > 1000 && /teal/i.test(prev.frame.right), prev.frame?.right);

  // 2. Colour match: the warm, dark camera is pulled toward the main camera.
  p = await get(id);
  const camB = p.plan.clips.find(c => c.sourceIndex === 1).id, ref = p.plan.clips[0].id;
  const cm = await tool('studio_color_match', { projectId: id, revision: p.revision, mode: 'match', reference: ref, strength: 1 });
  const fixB = cm.report.find(r => r.clip === camB);
  check('colour match cools and brightens the warm, dark camera', fixB.set.temperature < -0.2 && fixB.set.brightness > 0.03, JSON.stringify(fixB));
  const auto = await tool('studio_color_match', { projectId: id, revision: cm.project.revision, mode: 'auto', dryRun: true });
  check('auto colour dry run reports every shot', auto.dryRun && auto.report.length === 4);

  // 3. Stabilisation (measured in the background).
  const st = await tool('studio_stabilize', { projectId: id, revision: cm.project.revision, clips: [camB], strength: 0.7 });
  p = await idle(id);
  const trf = await fs.readdir(path.join(DATA_ROOT, 'studio', 'projects', id, 'stab')).catch(() => []);
  check('stabilisation measured (vid.stab transforms)', st.measuring === 1 && trf.filter(f => f.endsWith('.trf')).length === 1 && p.plan.clips.find(c => c.id === camB).stabilize === 0.7, p.message);

  // 4. Audio repair: hum detected and removed; shot levels evened.
  const ar = await tool('studio_audio_repair', { projectId: id, action: 'analyze' });
  const talkRow = ar.sources.find(s => s.sourceIndex === 0);
  check('audio analysis finds the 50 Hz hum', ar.suggestion?.hum === 50 && talkRow.advice.hum === 50, JSON.stringify(talkRow.humDb));
  p = await get(id);
  const fix = await tool('studio_audio_repair', { projectId: id, action: 'apply', auto: true, levelShots: true, revision: p.revision });
  check('audio repair applied', fix.project.options.audioRepair?.hum === 50, fix.diff?.summary);

  // 5. Effects, a callout and a progress bar.
  p = fix.project;
  ed = await tool('studio_edit', { projectId: id, revision: p.revision, operations: [{ op: 'add_text', start: 2, end: 5, text: 'Subscribe', style: 'callout', position: 'high' }, { op: 'set_options', options: { progressBar: 'bottom' } }] });
  const sfx = await tool('studio_sfx', { projectId: id, action: 'auto', revision: ed.project.revision });
  check('sound effects placed on the transition and the text', sfx.sfx.some(x => x.kind === 'whoosh') && sfx.sfx.some(x => x.kind === 'pop'), sfx.sfx.map(x => `${x.kind}@${x.time}`).join(' '));

  // 6. Emphasis zooms and automatic B-roll.
  const before = sfx.project.plan.clips.length;
  const az = await tool('studio_auto_zoom', { projectId: id, revision: sfx.project.revision, style: 'punch', clips: sfx.project.plan.clips.filter(c => c.sourceIndex === 0).map(c => c.id) });
  check('emphasis zooms split talk shots and alternate the crop', az.project.plan.clips.length > before && az.project.plan.clips.some(c => (c.zoom ?? 1) > 1.1), az.detail);
  const ab = await tool('studio_auto_broll', { projectId: id, revision: az.project.revision, seconds: 2.5 });
  const rocketAt = words.find(w => w.text === 'rocket').start;
  check('B-roll placed where "rocket" is said', ab.method === 'keywords' && ab.project.options.overlays.some(o => o.sourceIndex === 2 && Math.abs(o.at - rocketAt) < 0.6), JSON.stringify(ab.reasons));

  const sp = await tool('studio_text_edit', { projectId: id, revision: ab.project.revision, sourceIndex: 0, speedPauses: { min: 0.6, speed: 2 }, dryRun: true });
  check('pauses can be sped up instead of cut (dry run)', sp.dryRun && sp.stats.spedUp >= 2 && sp.stats.secondsSaved > 0.5, JSON.stringify(sp.stats));

  // 7. Music to length.
  p = ab.project;
  ed = await tool('studio_edit', { projectId: id, revision: p.revision, operations: [{ op: 'set_options', options: { music: music, musicGain: 0.3 } }] });
  const dry = await tool('studio_music_fit', { projectId: id, revision: ed.project.revision, dryRun: true });
  const mf = await tool('studio_music_fit', { projectId: id, revision: ed.project.revision });
  const fitted = await probeAudio(mf.file);
  const edLen = mf.project.plan.actualDuration;
  check('music fitted on bar lines to the edit length', /bar/.test(mf.method) && Math.abs(fitted.duration - mf.project.options.musicTrimStart - edLen) < 0.6 && mf.bpm > 110 && mf.bpm < 130, `${dry.method}; ${fitted.duration.toFixed(2)} s − start ${mf.project.options.musicTrimStart} for ${edLen} s at ${mf.bpm} bpm`);
  check('music fit keeps the original file', mf.project.options.music !== music);

  // 8. Preview render with everything on; hum reduced; stabilisation, LUT, effects and bar in the graph.
  await tool('studio_render', { projectId: id, revision: mf.project.revision, preview: true });
  p = await idle(id);
  const pv = p.exports.at(-1);
  const graph = await lastFilter(id);
  check('preview renders with LUT, stabilisation, progress bar, effects and repair', p.status === 'ready' && /lut3d=/.test(graph) && /vidstabtransform=/.test(graph) && /\[pbar\]/.test(graph) && /\[sfx\]/.test(graph) && /bandreject=f=50/.test(graph) && /colortemperature=/.test(graph), p.message);
  const qc = (await tool('studio_qc', { projectId: id })).qc;
  check('render passes QC', qc.passed && Math.abs(pv.duration - p.plan.actualDuration) < 0.3, `${pv.duration}s, ${qc.loudness} LUFS`);

  // 9. Stems.
  await tool('studio_render', { projectId: id, revision: p.revision, formats: ['stems'] });
  p = await idle(id);
  const stems = p.exports.at(-1);
  const lens = await Promise.all((stems.files ?? []).map(async f => (await probeAudio(f.file)).duration));
  // Hum relative to the voice (180 Hz), source vs the dialogue stem (no music in it).
  const dlg = stems.files.find(f => f.stem === 'dialogue').file;
  const humBefore = (await bandDb(talk, 50, 9)) - (await bandDb(talk, 180, 9)), humAfter = (await bandDb(dlg, 50, 9)) - (await bandDb(dlg, 180, 9));
  check('mains hum removed (relative to the voice)', humBefore - humAfter > 15, `${humBefore.toFixed(1)} → ${humAfter.toFixed(1)} dB under the voice`);
  check('stems: dialogue, music, effects and mix as WAV', p.status === 'ready' && ['dialogue', 'music', 'sfx', 'mix'].every(s => stems.files?.some(f => f.stem === s)) && lens.every(l => Math.abs(l - p.plan.actualDuration) < 0.1), `${stems.files?.map(f => f.stem).join(', ')} · ${lens.map(l => l.toFixed(2)).join('/')}`);

  // 10. Compare two versions.
  ed = await tool('studio_lut', { projectId: id, action: 'remove', revision: p.revision });
  await tool('studio_render', { projectId: id, revision: ed.project.revision, preview: true });
  await idle(id);
  await tool('studio_compare', { projectId: id, layout: 'side' });
  p = await idle(id);
  const cmp = p.exports.at(-1);
  check('A/B comparison render', cmp.format === 'compare' && cmp.width === 1920 && cmp.height === 540 && cmp.duration > 5, `${cmp.width}x${cmp.height}, ${cmp.duration}s`);

  // 11. Batch over projects by name.
  const { project: second } = await tool('studio_create', { name: `Verify 0.9 second ${RUN}`, inputs: [talk], options: { label: '', endTitle: '' } });
  await tool('studio_analyze', { projectId: second.id, revision: second.revision });
  await idle(second.id);
  const batch = await tool('studio_batch', { tool: 'lut', arguments: { action: 'apply', name: 'my look', strength: 0.5 }, match: RUN });
  check('batch applies a LUT to every matching project', batch.projects === 2 && batch.ok === 2, JSON.stringify(batch.results.map(r => r.ok ? 'ok' : r.error)));

  for (const [file, digest] of Object.entries(originals)) check(`original untouched: ${path.basename(file)}`, (await hash(file)) === digest);
} catch (e) {
  check('unexpected error', false, e.stack);
} finally {
  server.kill();
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
