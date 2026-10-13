// Director 0.6 editor features: Director mode (auto-edit), edit-by-text (Words tab),
// smart reframe, publish pack and brand kits. Wired into studio.js through initDirector(ctx).
import { t, LOCALE } from './i18n.js';
import { findFillers, matchPhrase } from './transcript.js';
import { formatTime } from './edit-ops.js';

const $ = id => document.getElementById(id);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
const EMOJI = { shorts: '▶', tiktok: '♪', reels: '◎', feed: '◼', youtube: '▷', trailer: '🎮', vlog: '🎥', film: '🎬' };
const FORMAT_NAMES = { hd: '720p', landscape: '16:9', qhd: '1440p', uhd: '4K', ultrawide: '21:9', vertical720: '9:16 720', vertical: '9:16', vertical1440: '9:16 1440', vertical4k: '9:16 4K',
  square720: '1:1 720', square: '1:1', square1440: '1:1 1440', portrait720: '4:5 720', portrait: '4:5', portrait1440: '4:5 1440', whatsapp: 'WhatsApp' };

let ctx;
const D = { platforms: [], brands: [], speech: null, words: [], meta: null, source: 0, selection: new Set(), anchor: null, hits: [], platform: 'shorts', loadedFor: '', setupTimer: null };

/** Server-side edit that returns a new project revision (save first, then post with the current revision). */
async function serverEdit(action, body = {}, { label, needsRevision = true } = {}) {
  const { state } = ctx;
  if (!state.project || ctx.busy()) return null;
  if (!(await ctx.save({ quiet: true }))) return null;
  state.pending = true; state.inflight++; ctx.updateChrome();
  try {
    const data = await ctx.api(ctx.endpoint(action), 'POST', needsRevision ? { ...body, revision: state.project.revision } : body);
    if (data.project) { ctx.acceptProject(data.project); state.dirty = false; ctx.history.reset(ctx.snapshot()); ctx.fillOptions(); ctx.renderAll(); ctx.statusView(); }
    if (label) ctx.status(label);
    return data;
  } catch (e) { if (e.code === 'REVISION_CONFLICT') ctx.conflict(); else ctx.toast(e.message); return null; }
  finally { state.pending = false; state.inflight--; ctx.updateChrome(); }
}

// ------------------------------------------------------------------ Director mode
function platformCard(p) {
  const b = el('button', 'template-card'); b.type = 'button'; b.dataset.id = p.id;
  b.append(el('span', 'emoji', EMOJI[p.id] ?? '✦'), el('strong', '', t(p.name)),
    el('small', '', `${p.duration ? `${p.duration} s` : t('full length')} · ${p.formats.map(f => FORMAT_NAMES[f] ?? f).join(' + ')}`));
  b.onclick = () => { D.platform = p.id; $$('#auto-platforms .template-card').forEach(c => c.classList.toggle('selected', c.dataset.id === p.id)); };
  return b;
}
export function openAutoEdit(platform) {
  if (!ctx.state.project) return;
  if (platform) D.platform = platform;
  $('auto-platforms').replaceChildren(...D.platforms.map(platformCard));
  $$('#auto-platforms .template-card').forEach(c => c.classList.toggle('selected', c.dataset.id === D.platform));
  $('auto-message').textContent = '';
  $('auto-dialog').showModal();
}
export async function autoEdit(body) {
  const data = await serverEdit('auto-edit', body);
  if (data) { ctx.toast(t('Director mode is editing… you can watch the progress below.')); ctx.switchTab('right', 'check'); }
  return data;
}
function renderAutoReport() {
  const box = $('auto-report'), a = ctx.state.project?.autoEdit;
  if (!box) return;
  if (!a) { box.hidden = true; return; }
  box.hidden = false;
  const head = el('h4'); head.append(el('span', '', `✦ ${t('Auto-edit')} · ${t(a.platformName ?? a.platform)}`), el('span', 'muted', `${a.shots} ${t('shots')} · ${Number(a.duration).toFixed(1)} s · hook ${a.hook ?? '—'} · ${t('review')} ${a.review?.score ?? '—'}`));
  const steps = el('ol'); for (const s of a.steps ?? []) steps.append(el('li', '', s));
  const variants = el('div', 'variants');
  (a.variants ?? []).forEach((v, i) => variants.append(el('span', i === 0 ? 'best' : '', `${t(v.label)} · ${v.hook}`)));
  const parts = [head, steps, variants];
  if (a.variantProjects?.length) {
    const row = el('div', 'row-actions');
    for (const v of a.variantProjects) { const b = el('button', 'ghost', `${t('Open')} ${t(v.label)}`); b.type = 'button'; b.onclick = () => ctx.openProject(v.projectId); row.append(b); }
    parts.push(row);
  }
  box.replaceChildren(...parts);
}

// ------------------------------------------------------------------ Words (edit by text)
async function loadSpeech() {
  try { const { speech, setup } = await ctx.api('/api/speech'); D.speech = speech; renderSpeech(setup); } catch { /* optional */ }
}
function renderSpeech(setup) {
  const box = $('speech-box'), s = D.speech; if (!box || !s) return;
  box.classList.toggle('ready', s.ready);
  const parts = [];
  if (s.ready) parts.push(el('span', '', `✓ ${t('Local speech engine')}: ${s.engine} · ${s.models.map(m => m.name).join(', ')}`));
  else {
    parts.push(el('span', '', t('No speech engine installed yet. It is optional and runs fully on this computer.')));
    const install = el('button', 'secondary', t('Install speech engine (~200 MB)')); install.type = 'button';
    install.disabled = Boolean(setup?.running);
    install.onclick = async () => {
      if (!confirm(t('Download whisper.cpp from GitHub and the "base" speech model from Hugging Face into your data folder?'))) return;
      try { await ctx.api('/api/speech/setup', 'POST', { model: 'base' }); watchSetup(); } catch (e) { ctx.toast(e.message); }
    };
    parts.push(install);
    if (!/win/i.test(navigator.platform) && s.setup) parts.push(el('small', 'muted', s.setup));
  }
  if (setup?.log?.length || setup?.error) { const pre = el('pre'); pre.textContent = [...(setup.log ?? []), setup.error ? `✗ ${setup.error}` : ''].filter(Boolean).join('\n'); parts.push(pre); }
  box.replaceChildren(...parts);
  $('transcribe').disabled = !s.ready || ctx.busy();
}
function watchSetup() {
  clearInterval(D.setupTimer);
  D.setupTimer = setInterval(async () => {
    try {
      const { speech, setup } = await ctx.api('/api/speech'); D.speech = speech; renderSpeech(setup);
      if (!setup.running) { clearInterval(D.setupTimer); ctx.toast(setup.error ? setup.error : t('Speech engine installed. You can transcribe now.')); }
    } catch { clearInterval(D.setupTimer); }
  }, 1500);
}
async function loadTranscript({ force = false } = {}) {
  const p = ctx.state.project; if (!p) return;
  const key = `${p.id}:${p.revision}:${D.source}`;
  if (!force && key === D.loadedFor) return;
  D.loadedFor = key;
  try {
    let offset = 0, words = [], meta;
    do {
      const { transcript } = await ctx.api(`${ctx.endpoint('transcript')}?sourceIndex=${D.source}&format=words&limit=5000&offset=${offset}`);
      meta = transcript; words = words.concat(transcript.words); offset += 5000;
    } while (offset < meta.totalWords && offset < 60000);
    D.meta = meta; D.words = words;
  } catch (e) { D.meta = null; D.words = []; if (e.code !== 'TRANSCRIPT_MISSING') ctx.toast(e.message); }
  D.selection.clear(); D.hits = [];
  renderWords();
}
function renderWords() {
  const root = $('words'); if (!root) return;
  root.dataset.empty = t('No transcript for this source yet. Transcribe it locally or import an SRT/VTT/JSON transcript.');
  const m = D.meta;
  $('words-status').textContent = m ? t('{w} words · {f} fillers · {p} long pauses', { w: m.totalWords, f: m.fillers, p: m.longPauses }) : '';
  const fillers = new Set(m ? findFillers(D.words, m.language) : []);
  const hits = new Set(D.hits.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, k) => a + k)));
  const frag = document.createDocumentFragment();
  let lastStamp = -Infinity;
  for (const w of D.words) {
    if (w.start - lastStamp >= 30) { frag.append(el('span', 'stamp', formatTime(w.start, 0))); lastStamp = w.start; }
    const s = el('span', 'w', w.text); s.dataset.i = w.i;
    if (!w.inEdit) s.classList.add('out');
    if (fillers.has(w.i)) s.classList.add('filler');
    if (w.lowConfidence) s.classList.add('low');
    if (hits.has(w.i)) s.classList.add('hit');
    if (D.selection.has(w.i)) s.classList.add('sel');
    frag.append(s, ' ');
  }
  root.replaceChildren(frag);
  const locked = ctx.busy() || !D.words.length;
  $('words-delete').disabled = locked || !D.selection.size; $('words-keep').disabled = locked || !D.selection.size;
  $('words-fillers').disabled = locked || !fillers.size; $('words-pauses').disabled = locked || !m?.longPauses;
  $('words-fillers').textContent = fillers.size ? t('Remove fillers ({n})', { n: fillers.size }) : t('Remove fillers');
  $('words-pauses').textContent = m?.longPauses ? t('Tighten pauses ({n})', { n: m.longPauses }) : t('Tighten pauses');
}
function selectionRanges() {
  const sorted = [...D.selection].sort((a, b) => a - b), out = [];
  for (const i of sorted) { const last = out.at(-1); if (last && i === last.to + 1) last.to = i; else out.push({ from: i, to: i }); }
  return out;
}
async function textEdit(body, label) {
  const data = await serverEdit('text-edit', { sourceIndex: D.source, smooth: $('words-smooth').checked, ...body }, { label });
  if (data) { D.selection.clear(); await loadTranscript({ force: true }); if (data.stats) ctx.toast(t('{s} s removed. Every step is in History if you want it back.', { s: data.stats.secondsRemoved ?? 0 })); }
}
function bindWords() {
  $('words').onclick = e => {
    const span = e.target.closest('.w'); if (!span) return;
    const i = Number(span.dataset.i), w = D.words.find(x => x.i === i);
    if (e.shiftKey && D.anchor != null) { const [a, b] = [Math.min(D.anchor, i), Math.max(D.anchor, i)]; for (let k = a; k <= b; k++) D.selection.add(k); }
    else if (e.ctrlKey || e.metaKey) { if (D.selection.has(i)) D.selection.delete(i); else D.selection.add(i); D.anchor = i; }
    else { D.selection = new Set([i]); D.anchor = i; if (w?.inEdit && Number.isFinite(w.timeline)) ctx.seek(w.timeline); }
    renderWords();
  };
  $('words').onkeydown = e => { if ((e.key === 'Delete' || e.key === 'Backspace') && D.selection.size) { e.preventDefault(); e.stopPropagation(); $('words-delete').click(); } };
  $('words-search').oninput = () => {
    const q = $('words-search').value.trim();
    D.hits = q ? matchPhrase(D.words, q) : [];
    renderWords();
    const first = D.hits[0] && $('words').querySelector(`[data-i="${D.hits[0][0]}"]`); first?.scrollIntoView({ block: 'center' });
  };
  $('words-search').onkeydown = e => {
    if (e.key !== 'Enter' || !D.hits.length) return;
    e.preventDefault(); D.selection = new Set(D.hits.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, k) => a + k))); renderWords();
    ctx.toast(t('{n} matches selected. Press Delete selected to cut them all.', { n: D.hits.length }));
  };
  $('words-delete').onclick = () => textEdit({ removeWords: selectionRanges() }, t('Words removed'));
  $('words-keep').onclick = () => {
    if (!confirm(t('Make the timeline only the selected passages (paper edit)? Everything else is removed; History keeps the old version.'))) return;
    textEdit({ assemble: selectionRanges().map(r => ({ sourceIndex: D.source, ...r })) }, t('Paper edit made'));
  };
  $('words-fillers').onclick = () => textEdit({ removeFillers: true }, t('Fillers removed'));
  $('words-pauses').onclick = () => textEdit({ removePauses: { min: 0.8, keep: 0.2 } }, t('Pauses tightened'));
  $('words-source').onchange = () => { D.source = Number($('words-source').value) || 0; loadTranscript({ force: true }); };
  $('transcribe').onclick = async () => {
    const data = await serverEdit('transcribe', { sourceIndex: D.source, language: $('words-language').value }, { label: t('Transcribing locally…') });
    if (data) ctx.toast(t('Transcribing on this computer. Captions follow automatically when it is done.'));
  };
  $('import-transcript').onclick = () => $('transcript-picker').click();
  $('transcript-picker').onchange = async e => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    try {
      const path = await ctx.upload(file, pct => ctx.status(t('Importing · {p}%', { p: pct })));
      const data = await serverEdit('transcript', { sourceIndex: D.source, file: path, captions: true }, { label: t('Transcript imported') });
      if (data) await loadTranscript({ force: true });
    } catch (err) { ctx.toast(err.message); }
  };
}

// ------------------------------------------------------------------ Reframe
function renderShotPan() {
  const out = $('shot-pan'); if (!out) return;
  const clip = ctx.state.clips.find(c => ctx.state.selection.has(c.id));
  out.textContent = clip?.focusXEnd !== undefined || clip?.focusYEnd !== undefined
    ? t('pans {a} → {b}', { a: `${Math.round((clip.focusX ?? 0.5) * 100)}%`, b: `${Math.round((clip.focusXEnd ?? clip.focusX ?? 0.5) * 100)}%` }) : '';
}
async function reframe(body) {
  const data = await serverEdit('reframe', body, { label: t('Reframed') });
  if (data) ctx.toast(data.reframed ? t('{n} shot(s) now follow the action ({p} panning). Check them in 9:16.', { n: data.reframed, p: data.panning }) : t('Nothing to reframe (same aspect or still images).'),
    [[t('Show 9:16'), () => document.querySelector('[data-aspect="9:16"]')?.click()]]);
}

// ------------------------------------------------------------------ Publish pack
async function makePublishPack() {
  const { state } = ctx;
  if (!state.project || ctx.busy()) return;
  if (!(await ctx.save({ quiet: true }))) return;
  const button = $('publish-make'); button.disabled = true; ctx.status(t('Choosing the best frames…'));
  try {
    const platforms = $$('#publish-platforms input:checked').map(i => i.value);
    const title = $('publish-title').value.trim();
    const { publish } = await ctx.api(ctx.endpoint('publish'), 'POST', { platforms, ...(title ? { title } : {}) });
    renderPublish(publish); ctx.status(t('Publish pack ready'));
  } catch (e) { ctx.toast(e.message); } finally { button.disabled = false; }
}
function renderPublish(pack) {
  const root = $('publish-result');
  const url = file => `${ctx.endpoint('publish-file')}?path=${encodeURIComponent(file)}`;
  const thumbs = el('div', 'thumbs');
  for (const f of pack.files.filter(x => x.kind === 'thumbnail' || x.kind === 'cover').slice(0, 6)) {
    const img = el('img', f.kind === 'cover' ? 'tall' : ''); img.src = url(f.file); img.alt = f.kind; img.title = f.file; img.loading = 'lazy'; thumbs.append(img);
  }
  const drafts = Object.values(pack.drafts).map(d => {
    const box = el('article', 'draft'), head = el('header');
    const text = `${d.title ? `${d.title}\n\n` : ''}${d.description}`;
    const copyBtn = el('button', 'ghost', t('Copy')); copyBtn.type = 'button';
    copyBtn.onclick = () => navigator.clipboard.writeText(text).then(() => ctx.toast(t('Copied — review it before posting.')), () => ctx.toast(text));
    head.append(el('strong', '', d.platform), copyBtn); const pre = el('pre'); pre.textContent = text;
    box.append(head, pre); return box;
  });
  const folder = el('button', 'ghost wide', t('Copy folder path')); folder.type = 'button';
  folder.onclick = () => navigator.clipboard.writeText(pack.folder).then(() => ctx.toast(t('Folder path copied.')), () => ctx.toast(pack.folder));
  root.replaceChildren(thumbs, ...(pack.chapters?.length ? [el('small', 'muted', `${t('Chapters')}: ${pack.chapters.map(c => c.line).join(' · ')}`)] : []), ...drafts, el('small', 'muted', t('Drafts only — built from your title, brief and call to action. Nothing was posted.')), folder);
}

// ------------------------------------------------------------------ Brand kits
async function loadBrands() {
  try {
    const { brands } = await ctx.api('/api/studio/brands'); D.brands = brands;
    for (const [id, empty] of [['brand-select', t('— Brand kits —')], ['auto-brand', t('— None —')]]) {
      const sel = $(id); const current = sel.value;
      sel.replaceChildren(Object.assign(el('option', '', empty), { value: '' }), ...brands.map(b => Object.assign(el('option', '', b.name), { value: b.id })));
      sel.value = current;
    }
  } catch { /* optional */ }
}
let pickTarget = '';
function bindBrand() {
  $$('[data-pick]').forEach(b => b.onclick = () => {
    pickTarget = b.dataset.pick;
    $('brand-picker').accept = { 'brand-logo': '.png,.jpg,.jpeg', 'brand-font': '.ttf,.otf', 'brand-intro': 'video/*,.mkv', 'brand-outro': 'video/*,.mkv' }[pickTarget] ?? '';
    $('brand-picker').click();
  });
  $('brand-picker').onchange = async e => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    try { $(pickTarget).value = await ctx.upload(file, pct => ctx.status(t('Importing · {p}%', { p: pct }))); ctx.status(t('File ready for your edit.')); } catch (err) { ctx.toast(err.message); }
  };
  $('brand-select').onchange = () => {
    const b = D.brands.find(x => x.id === $('brand-select').value); if (!b) return;
    for (const k of ['name', 'logo', 'font', 'intro', 'outro', 'cta']) $(`brand-${k}`).value = b[k] ?? '';
    for (const k of ['primary', 'accent', 'text']) $(`brand-${k}`).value = (b[k] ?? '#000000').toLowerCase();
    $('brand-logoPosition').value = b.logoPosition ?? 'top-left'; $('brand-logoScale').value = String(b.logoScale ?? 0.13);
    $('brand-hashtags').value = (b.hashtags ?? []).join(', ');
  };
  $('brand-apply').onclick = async () => {
    const name = $('brand-select').value; if (!name) return ctx.toast(t('Choose a brand kit first.'));
    if (await serverEdit('brand', { name }, { label: t('Brand kit applied') })) ctx.toast(t('Brand kit applied: logo, colours, font and intro/outro are used in every render.'));
  };
  $('brand-save').onclick = async () => {
    const body = { name: $('brand-name').value.trim(), logoPosition: $('brand-logoPosition').value, logoScale: Number($('brand-logoScale').value),
      primary: $('brand-primary').value, accent: $('brand-accent').value, text: $('brand-text').value,
      hashtags: $('brand-hashtags').value.split(/[,\s#]+/).filter(Boolean) };
    for (const k of ['logo', 'font', 'intro', 'outro', 'cta']) { const v = $(`brand-${k}`).value.trim(); if (v) body[k] = v; }
    try { const { brand } = await ctx.api('/api/studio/brands', 'POST', body); await loadBrands(); $('brand-select').value = brand.id; ctx.toast(t('Brand kit "{n}" saved. Your agent can use it too.', { n: brand.name })); }
    catch (e) { ctx.toast(e.message); }
  };
}

// ------------------------------------------------------------------ wiring
export function renderDirector() {
  if (!ctx?.state.project) return;
  renderAutoReport(); renderShotPan();
  const p = ctx.state.project;
  const sel = $('words-source');
  if (sel && sel.options.length !== p.sources.length) {
    sel.replaceChildren(...p.sources.map((s, i) => Object.assign(el('option', '', `${i + 1} · ${s.name}${p.transcripts?.[i] ? ' ✓' : ''}`), { value: i })));
    sel.value = String(D.source);
  }
  $('publish-title').placeholder = ctx.state.options.title || t('Uses your opening title');
  $('auto-edit-open').disabled = ctx.busy() || !p.sources.length;
  $('reframe-all').disabled = ctx.busy() || !ctx.state.clips.length; $('shot-reframe').disabled = ctx.busy() || !ctx.state.selection.size;
  $('publish-make').disabled = ctx.busy() || !ctx.state.clips.length;
  if (document.querySelector('.right .tabs button.active')?.dataset.tab === 'words') { loadTranscript(); if (D.speech) $('transcribe').disabled = !D.speech.ready || ctx.busy(); }
}
export function onTab(tab) { if (tab === 'words') { loadSpeech(); loadTranscript({ force: true }); } }
export function resetDirector() { D.source = 0; D.words = []; D.meta = null; D.loadedFor = ''; D.selection.clear(); $('publish-result')?.replaceChildren(); }
export async function loadPlatforms() {
  try {
    const { platforms } = await ctx.api('/api/studio/platforms'); D.platforms = platforms;
    $('create-platform').replaceChildren(Object.assign(el('option', '', t("— I'll edit myself —")), { value: '' }), ...platforms.map(p => Object.assign(el('option', '', `${EMOJI[p.id] ?? '✦'} ${t(p.name)}`), { value: p.id })));
  } catch { /* optional */ }
}

export function initDirector(context) {
  ctx = context;
  $('auto-edit-open').onclick = () => openAutoEdit();
  $('auto-form').onsubmit = async e => {
    e.preventDefault();
    const body = { platform: D.platform, ...($('auto-render').checked ? { render: true } : { preview: true }) };
    const n = Number($('auto-duration').value); if (n >= 5) body.duration = n;
    for (const [id, key] of [['auto-pace', 'pace'], ['auto-keep', 'keep'], ['auto-hook', 'hookText'], ['auto-cta', 'cta'], ['auto-brand', 'brand']]) { const v = $(id).value.trim(); if (v) body[key] = v; }
    if ($('auto-variants').checked) body.variants = true;
    if (ctx.state.options.title) body.title = ctx.state.options.title;
    $('auto-submit').disabled = true;
    try { if (await autoEdit(body)) $('auto-dialog').close(); } finally { $('auto-submit').disabled = false; }
  };
  $$('#auto-dialog [data-close]').forEach(b => b.onclick = () => $('auto-dialog').close());
  $('reframe-all').onclick = () => reframe({ aspect: $('reframe-aspect').value });
  $('shot-reframe').onclick = () => {
    const ids = ctx.state.clips.filter(c => ctx.state.selection.has(c.id)).map(c => c.id);
    if (ids.length) reframe({ aspect: ['1:1', '4:5'].includes(ctx.state.aspect) ? ctx.state.aspect : '9:16', clips: ids });
  };
  $('publish-make').onclick = makePublishPack;
  bindWords(); bindBrand(); loadBrands(); loadPlatforms();
}
export { LOCALE };
