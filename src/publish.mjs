// Publish pack: thumbnails/covers, timeline-timed SRT/VTT, chapters and per-platform title,
// description and hashtag DRAFTS. Everything is written locally; nothing is uploaded.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StudioError, writeJsonAtomic } from './paths.mjs';
import { findFfmpegTools, inspectFfmpeg } from './ffmpeg.mjs';
import { runProcess } from './process.mjs';
import { filterColors } from './render.mjs';
import { layout, totalDuration } from '../public/edit-ops.js';
import { curvesFor, clipEnergy } from '../public/insights.js';
import { mapCaptions, toSrt } from '../public/captions.js';

export const PUBLISH_PLATFORMS = Object.freeze({
  youtube: { name: 'YouTube', titleMax: 100, descriptionMax: 5000, tags: [] },
  shorts: { name: 'YouTube Shorts', titleMax: 100, descriptionMax: 5000, tags: ['shorts'] },
  tiktok: { name: 'TikTok', titleMax: 0, descriptionMax: 2200, tags: [] },
  reels: { name: 'Instagram Reels', titleMax: 0, descriptionMax: 2200, tags: ['reels'] },
  x: { name: 'X', titleMax: 0, descriptionMax: 280, tags: [] },
  linkedin: { name: 'LinkedIn', titleMax: 0, descriptionMax: 3000, tags: [] },
  steam: { name: 'Steam / store page', titleMax: 0, descriptionMax: 300, tags: [] },
});
const fmt = s => { const t = Math.max(0, Math.round(s)); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), x = t % 60; return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 2, '0')}:${String(x).padStart(2, '0')}`; };
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const filterPath = value => path.resolve(value).replaceAll('\\', '/').replace(':', '\\:').replaceAll("'", "\\'");

/** YouTube-style chapters (first at 0:00, ≥3 chapters, ≥10 s apart) from labelled markers or clip labels. */
export function chapters(clips, options = {}) {
  const total = totalDuration(clips);
  let rows = (options.markers ?? []).filter(m => m.label).map(m => ({ time: m.time, title: clean(m.label, 60) }));
  if (rows.length < 2) rows = layout(clips).filter(r => r.label && r.label !== 'hook').map(r => ({ time: r.visibleStart, title: clean(r.label, 60) }));
  rows = rows.filter(r => r.time < total - 10).sort((a, b) => a.time - b.time);
  const out = [];
  for (const r of rows) if (!out.length || r.time - out.at(-1).time >= 10) out.push(r);
  if (out.length && out[0].time > 0.5) out.unshift({ time: 0, title: 'Intro' }); else if (out.length) out[0].time = 0;
  return out.length >= 3 ? out.map(r => ({ time: Math.round(r.time), title: r.title, line: `${fmt(r.time)} ${r.title}` })) : [];
}

export function hashtags(...texts) {
  const words = texts.join(' ').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[\p{L}\p{N}]{4,}/gu) ?? [];
  const stop = new Set(['with', 'this', 'that', 'from', 'your', 'have', 'will', 'what', 'when', 'into', 'over', 'they', 'them', 'voor', 'naar', 'deze', 'met', 'maar', 'niet', 'zijn', 'wordt', 'worden', 'onze', 'jouw', 'heeft', 'more', 'than', 'just', 'like']);
  const seen = new Set();
  return words.map(w => w.toLowerCase()).filter(w => !stop.has(w) && !/^\d+$/.test(w) && !seen.has(w) && seen.add(w)).slice(0, 5);
}

/** Draft copy per platform from the user's own title/brief/CTA. No invented claims. */
export function metadataDrafts({ title, brief, cta, chapterList = [], tags = [], platforms }) {
  const base = clean(title, 100) || 'Untitled';
  const about = clean(brief, 600);
  const out = {};
  for (const id of platforms) {
    const p = PUBLISH_PLATFORMS[id]; if (!p) continue;
    const list = [...new Set([...p.tags, ...tags])].slice(0, id === 'x' ? 2 : 6).map(t => `#${t}`);
    const pieces = [about || base, cta ? clean(cta, 100) : '', id === 'youtube' && chapterList.length ? `\n${chapterList.map(c => c.line).join('\n')}` : '', list.join(' ')].filter(Boolean);
    let description = pieces.join('\n\n');
    if (description.length > p.descriptionMax) description = `${description.slice(0, p.descriptionMax - 1).trimEnd()}…`;
    out[id] = { platform: p.name, ...(p.titleMax ? { title: base.slice(0, p.titleMax) } : {}), description, hashtags: list, draft: true };
  }
  return out;
}

function grabGray(file, time, tools, still) {
  return new Promise(resolve => {
    const child = spawn(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', ...(still ? [] : ['-ss', time.toFixed(3)]), '-protocol_whitelist', 'file,pipe', '-i', file,
      '-frames:v', '1', '-vf', 'scale=160:90,format=gray', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true });
    const chunks = [];
    child.stdout.on('data', c => chunks.push(c)); child.on('error', () => resolve(null)); child.on('close', () => { const b = Buffer.concat(chunks); resolve(b.length >= 160 * 90 ? b : null); });
  });
}
/** Sharpness (Laplacian variance), exposure and contrast of a frame: a cheap "is this a good still?" score. */
export function frameQuality(buffer, w = 160, h = 90) {
  let sum = 0, sq = 0, lap = 0, lapSq = 0, n = 0;
  for (let i = 0; i < w * h; i++) { sum += buffer[i]; sq += buffer[i] ** 2; }
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, l = 4 * buffer[i] - buffer[i - 1] - buffer[i + 1] - buffer[i - w] - buffer[i + w];
    lap += l; lapSq += l * l; n++;
  }
  const mean = sum / (w * h), std = Math.sqrt(Math.max(0, sq / (w * h) - mean ** 2)), sharp = lapSq / n - (lap / n) ** 2;
  const exposure = mean < 35 || mean > 225 ? 0 : 1 - Math.abs(mean - 125) / 125;
  return { mean: Math.round(mean), contrast: Math.round(std), sharpness: Math.round(sharp), score: Math.min(1, sharp / 900) * 0.5 + Math.min(1, std / 70) * 0.3 + exposure * 0.2 };
}

/** Pick the best still moments of the edit (energetic clips, sharp and well-exposed frames). */
export async function pickStills(project, { count = 3, tools = findFfmpegTools() } = {}) {
  const clips = project.plan.clips;
  const analyzed = project.sources.some(s => s.motion?.length);
  const curves = analyzed ? curvesFor(project.sources) : null;
  const rows = layout(clips).map(r => ({ r, energy: curves ? clipEnergy(curves, r) : 0.5 }));
  const candidates = [];
  for (const { r, energy } of rows.sort((a, b) => b.energy - a.energy).slice(0, 8)) {
    for (const f of [0.35, 0.6]) candidates.push({ clip: r, sourceIndex: r.sourceIndex, time: r.start + (r.end - r.start) * f, energy });
  }
  const scored = [];
  for (const c of candidates) {
    const source = project.sources[c.sourceIndex];
    const buf = await grabGray(source.file, c.time, tools, source.still);
    if (!buf) continue;
    const q = frameQuality(buf);
    scored.push({ ...c, quality: q, score: q.score * 0.75 + c.energy * 0.25 });
  }
  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const s of scored) { if (picked.length >= count) break; if (picked.some(p => p.clip.id === s.clip.id)) continue; picked.push(s); }
  return picked;
}

/** Render a thumbnail/cover with an optional big title and a brand accent bar. */
async function renderStill({ source, time, out, width, height, focusX = 0.5, focusY = 0.5, title, titleFile, lines = 1, fontFile, colors, tools, drawtext }) {
  const c = filterColors(colors);
  const vertical = height > width;
  const size = Math.round((vertical ? width / 7 : width / 13));
  let vf = `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height}:(iw-ow)*${focusX}:(ih-oh)*${focusY},eq=contrast=1.06:saturation=1.12,setsar=1`;
  if (title && drawtext) {
    // The title block ends at ~86% (vertical, above the platform UI) or ~90% of the height.
    const top = Math.round(height * (vertical ? 0.86 : 0.9) - size * 1.17 * lines);
    const font = fontFile ? `fontfile='${filterPath(fontFile)}':` : '';
    vf += `,drawbox=x=${Math.round(width * 0.05)}:y=${top}:w=${Math.round(width * 0.012)}:h=${Math.round(size * (1.17 * lines + 0.05))}:color=${c.accent}@1:t=fill`;
    vf += `,drawtext=${font}textfile='${filterPath(titleFile)}':expansion=none:fontcolor=${c.text}:fontsize=${size}:borderw=${Math.max(3, Math.round(size / 10))}:bordercolor=black@0.85:line_spacing=${Math.round(size / 6)}:x=w*0.08:y=${top}`;
  }
  await runProcess(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-n', ...(source.still ? [] : ['-ss', time.toFixed(3)]), '-protocol_whitelist', 'file,pipe', '-i', source.file,
    '-frames:v', '1', '-vf', vf, '-q:v', '2', out], { timeoutMs: 60_000 });
}
function wrapTitle(text, max) {
  const lines = []; let line = '';
  for (const word of text.split(' ')) { if (line && (line + ' ' + word).length > max) { lines.push(line); line = ''; } line += (line ? ' ' : '') + word; }
  if (line) lines.push(line);
  return lines.slice(0, 3).join('\n');
}

/**
 * Build the publish pack into `dir`. Returns the manifest.
 * request: {title?, platforms?, thumbnails?: 1-6, captions?: bool}
 */
export async function buildPublishPack(project, dir, request = {}, { brand = null, tools = findFfmpegTools() } = {}) {
  if (!project.plan?.clips?.length) throw new StudioError('PLAN_REQUIRED', 'Create an edit first.');
  const platforms = (request.platforms?.length ? request.platforms : ['youtube', 'shorts', 'tiktok', 'reels']).filter(p => PUBLISH_PLATFORMS[p]);
  if (!platforms.length) throw new StudioError('INVALID_PLATFORM', `Choose from ${Object.keys(PUBLISH_PLATFORMS).join(', ')}.`);
  await fs.mkdir(dir, { recursive: true });
  const info = await inspectFfmpeg({ smokeTest: false, tools }).catch(() => ({ capabilities: {} }));
  const title = clean(request.title ?? project.options.title ?? project.name, 80);
  const titleFile = path.join(dir, `.title-${randomUUID()}.txt`);
  const fontFile = brand?.font && fsSync.existsSync(brand.font) ? brand.font
    : process.platform === 'win32' && fsSync.existsSync('C:\\Windows\\Fonts\\segoeuib.ttf') ? 'C:\\Windows\\Fonts\\segoeuib.ttf' : null;
  const files = [];
  const stills = await pickStills(project, { count: Math.max(1, Math.min(6, Number(request.thumbnails) || 3)), tools });
  try {
    for (const [i, s] of stills.entries()) {
      const source = project.sources[s.sourceIndex];
      for (const kind of ['thumbnail', 'cover']) {
        const vertical = kind === 'cover';
        const wrapped = wrapTitle(title, vertical ? 12 : 22);
        await fs.writeFile(titleFile, wrapped, 'utf8');
        const out = path.join(dir, `${kind}-${i + 1}.jpg`);
        await renderStill({ source, time: s.time, out, width: vertical ? 1080 : 1280, height: vertical ? 1920 : 720, focusX: vertical ? s.clip.focusX ?? 0.5 : 0.5, focusY: s.clip.focusY ?? 0.5,
          title, titleFile, lines: wrapped.split('\n').length, fontFile, colors: brand ? { primary: brand.primary, accent: brand.accent, text: brand.text } : {}, tools, drawtext: info.capabilities?.drawtext });
        files.push({ kind, file: out, sourceIndex: s.sourceIndex, sourceTime: Math.round(s.time * 1000) / 1000, quality: s.quality });
      }
      const plain = path.join(dir, `still-${i + 1}.jpg`);
      await renderStill({ source, time: s.time, out: plain, width: 1920, height: 1080, tools, drawtext: false });
      files.push({ kind: 'still', file: plain, sourceIndex: s.sourceIndex, sourceTime: Math.round(s.time * 1000) / 1000 });
    }
  } finally { await fs.rm(titleFile, { force: true }).catch(() => {}); }
  const cues = mapCaptions(project.options.captions ?? [], project.plan.clips, Number(project.options.captionOffset) || 0);
  if (cues.length) {
    const srt = path.join(dir, 'captions.srt'); await fs.writeFile(srt, toSrt(cues), 'utf8'); files.push({ kind: 'captions', file: srt });
    const vtt = path.join(dir, 'captions.vtt'); await fs.writeFile(vtt, `WEBVTT\n\n${toSrt(cues).replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2')}`, 'utf8'); files.push({ kind: 'captions', file: vtt });
  }
  const chapterList = chapters(project.plan.clips, project.options);
  const tags = [...(brand?.hashtags ?? []), ...hashtags(title, project.options.brief ?? '')].slice(0, 6);
  const drafts = metadataDrafts({ title, brief: project.options.brief, cta: project.options.endTitle, chapterList, tags, platforms });
  const md = [`# ${title}`, '', `Revision ${project.revision} · ${totalDuration(project.plan.clips).toFixed(1)} s · drafts — review before posting.`, '',
    ...(chapterList.length ? ['## Chapters', '', ...chapterList.map(c => c.line), ''] : []),
    ...Object.values(drafts).flatMap(d => [`## ${d.platform}`, '', ...(d.title ? [`**Title:** ${d.title}`, ''] : []), d.description, '']),
    '## Files', '', ...files.map(f => `- ${f.kind}: ${path.basename(f.file)}`)].join('\n');
  const notes = path.join(dir, 'publish.md'); await fs.writeFile(notes, md, 'utf8'); files.push({ kind: 'notes', file: notes });
  const manifest = { schemaVersion: 1, projectId: project.id, revision: project.revision, createdAt: new Date().toISOString(), title, folder: dir,
    files, chapters: chapterList, drafts, uploads: false,
    note: 'Titles, descriptions and hashtags are drafts built only from your title, brief and call to action. Nothing was uploaded or posted.' };
  await writeJsonAtomic(path.join(dir, 'publish.json'), manifest);
  return manifest;
}
