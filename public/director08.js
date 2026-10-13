// Director 0.8 editor features for long edits: outline (sections), search, fit to length, range renders,
// review notes, script → rough cut, sync + multicam, timeline hand-off (EDL/FCPXML/OTIO/CSV/chapters), proxies.
import { t } from './i18n.js';
import { formatTime, sectionSpans, totalDuration } from './edit-ops.js';

const $ = id => document.getElementById(id);
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
function button(label, cls, onclick, title) { const b = el('button', cls, label); b.type = 'button'; b.onclick = onclick; if (title) b.title = title; return b; }
let ctx;
const S = { hits: null, comments: [], proxies: null, sync: null };

/** POST to a project action; accepts a returned project (new revision) into the editor. */
async function call(action, body = {}, { label, revision = false, save = true } = {}) {
  const { state } = ctx;
  if (!state.project || ctx.busy()) return null;
  if (save && !(await ctx.save({ quiet: true }))) return null;
  state.pending = true; state.inflight++; ctx.updateChrome();
  try {
    const data = await ctx.api(ctx.endpoint(action), 'POST', revision ? { ...body, revision: state.project.revision } : body);
    const project = data.project ?? data.proxies?.project;
    if (project && !data.dryRun) { ctx.acceptProject(project); state.dirty = false; ctx.history.reset(ctx.snapshot()); ctx.fillOptions(); ctx.renderAll(); ctx.statusView(); ctx.pollSoon(); }
    if (label) ctx.status(label);
    return data;
  } catch (e) { if (e.code === 'REVISION_CONFLICT') ctx.conflict(); else ctx.toast(e.message); return null; }
  finally { state.pending = false; state.inflight--; ctx.updateChrome(); }
}
const clock = s => formatTime(s, 0);
function parseClock(text) {
  const v = String(text ?? '').trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
  const m = v.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
}

// ------------------------------------------------------------------ outline (sections)
function sections() { return sectionSpans(ctx.state.clips, ctx.state.options.sections ?? []); }
function renderOutline() {
  const root = $('outline-list'); if (!root) return;
  const spans = sections();
  $('outline-count').textContent = spans.length ? `${spans.length}` : '';
  if (!spans.length) { root.replaceChildren(el('p', 'help', t('No sections yet. Long edits are easier in chapters: add one at the playhead or let the engine suggest them.'))); return; }
  root.replaceChildren(...spans.map((s, k) => {
    const row = el('div', 'outline-row'), name = el('button', 'link', s.name);
    name.type = 'button'; name.onclick = () => ctx.seek(s.start); name.title = t('Jump to this section');
    const meta = el('small', 'muted', `${clock(s.start)} · ${clock(s.duration)} · ${t('{n} shots', { n: s.clipIds.length })}`);
    const tools = el('span', 'row-tools');
    const up = button('↑', 'ghost tiny', () => moveSection(s, spans[k - 1]), t('Move this section up')); up.disabled = !k || ctx.busy();
    const down = button('↓', 'ghost tiny', () => moveSection(spans[k + 1], s), t('Move this section down')); down.disabled = k === spans.length - 1 || ctx.busy();
    const rename = button('✎', 'ghost tiny', () => { const n = prompt(t('New name for "{n}"', { n: s.name }), s.name); if (n?.trim()) call('sections', { action: 'rename', name: s.name, newName: n.trim() }, { revision: true, label: t('Section renamed') }); }, t('Rename'));
    const drop = button('✕', 'ghost tiny', () => call('sections', { action: 'remove', name: s.name }, { revision: true, label: t('Section marker removed (shots kept)') }), t('Remove the section marker (keeps the shots)'));
    const del = button('🗑', 'ghost tiny danger', () => { if (confirm(t('Delete section "{n}" and its {c} shots ({d})?', { n: s.name, c: s.clipIds.length, d: clock(s.duration) }))) call('sections', { action: 'delete', name: s.name }, { revision: true, label: t('Section deleted') }); }, t('Delete the section with its shots'));
    tools.append(up, down, rename, drop, del);
    const text = el('div'); text.append(name, meta);
    row.append(el('span', `swatch ${s.color ?? 'yellow'}`), text, tools);
    return row;
  }));
}
function moveSection(section, before) { if (section && before) call('sections', { action: 'move', name: section.name, before: before.name }, { revision: true, label: t('Section moved') }); }
async function addSection() {
  const name = $('outline-name').value.trim() || t('Part {n}', { n: sections().length + 1 });
  const data = await call('sections', { action: 'add', name, at: ctx.state.playhead }, { revision: true, label: t('Section added') });
  if (data) $('outline-name').value = '';
}
async function suggestSections() {
  const data = await call('sections', { action: 'suggest' }, { save: true });
  if (!data?.suggestions?.length) return ctx.toast(t('No suggestions: add labelled markers or more sources first.'));
  if (!confirm(t('Add {n} sections?\n{list}', { n: data.suggestions.length, list: data.suggestions.slice(0, 12).map(s => `${clock(s.at)} ${s.name}`).join('\n') }))) return;
  call('sections', { action: 'add', sections: data.suggestions.map(s => ({ name: s.name, clip: s.clip })) }, { revision: true, label: t('Sections added') });
}

// ------------------------------------------------------------------ search
async function search() {
  const query = $('search-query').value.trim(); if (!query || !ctx.state.project) return;
  try { const data = await ctx.api(ctx.endpoint('search'), 'POST', { query, limit: 25 }); S.hits = data.hits; renderHits(); }
  catch (e) { ctx.toast(e.message); }
}
function renderHits() {
  const root = $('search-results'); if (!root) return;
  if (!S.hits) { root.replaceChildren(); return; }
  if (!S.hits.length) { root.replaceChildren(el('p', 'help', t('Nothing found.'))); return; }
  root.replaceChildren(...S.hits.map(h => {
    const row = el('div', 'hit-row'), text = el('div');
    const where = h.timeline != null ? `${t('edit')} ${clock(h.timeline)}` : `${t('source')} ${h.sourceIndex + 1} · ${clock(h.start)}`;
    text.append(el('small', 'muted', `${t(h.kind)} · ${where}`), el('span', '', h.text));
    text.onclick = () => (h.timeline != null ? ctx.seek(h.timeline) : ctx.peekSource(h.sourceIndex, h.start));
    row.append(text);
    if (h.insert) row.append(button(t('＋ At playhead'), 'secondary tiny', () => ctx.edit([{ ...h.insert, at: ctx.state.playhead }], t('Inserted from search'))));
    return row;
  }));
}

// ------------------------------------------------------------------ fit to length, range render
async function fit() {
  const target = parseClock($('fit-target').value);
  if (!(target >= 3)) return ctx.toast(t('Type a length like 2:59 or 45:00.'));
  const preview = await call('fit-duration', { target, dryRun: true }, { revision: true });
  if (!preview) return;
  if (!preview.operations?.length && !preview.diff) return ctx.toast(t('The edit is already {d}.', { d: clock(preview.before) }));
  if (!confirm(t('Shorten {a} → {b}?\n{steps}', { a: clock(preview.before), b: clock(preview.after), steps: (preview.steps ?? []).join('\n') }))) return;
  call('fit-duration', { target }, { revision: true, label: t('Fitted to {d}', { d: clock(target) }) });
}
async function renderPart() {
  const r = ctx.state.range ?? {}, p = ctx.state.playhead;
  const from = r.in != null ? r.in : Math.max(0, p - 5), to = r.out != null ? r.out : from + 15;
  await call('render-range', { from, to, quality: $('range-quality').value }, { revision: true, label: t('Rendering {a}–{b}…', { a: clock(from), b: clock(to) }) });
}

// ------------------------------------------------------------------ review notes
async function loadComments() {
  if (!ctx.state.project) return;
  try { const data = await ctx.api(ctx.endpoint('comments'), 'POST', { action: 'list', status: 'all' }); S.comments = data.comments; renderComments(); } catch { /* optional */ }
}
function renderComments() {
  const root = $('notes-list'); if (!root) return;
  const open = S.comments.filter(c => !c.resolved).length;
  $('notes-count').textContent = open ? `${open}` : '';
  root.replaceChildren(...S.comments.map(c => {
    const row = el('div', `note-row${c.resolved ? ' resolved' : ''}`), text = el('div');
    const when = el('button', 'link', clock(c.time)); when.type = 'button'; when.onclick = () => ctx.seek(c.time);
    text.append(when, el('small', 'muted', ` ${c.author}${c.detached ? ` · ${t('shot removed')}` : ''}`), el('p', '', c.text));
    if (c.reply) text.append(el('small', 'muted', `↳ ${c.reply}`));
    const done = button(c.resolved ? t('Reopen') : t('Done'), 'secondary tiny', async () => { await call('comments', { action: c.resolved ? 'reopen' : 'resolve', id: c.id }, { save: false }); loadComments(); });
    const del = button('✕', 'ghost tiny', async () => { await call('comments', { action: 'delete', id: c.id }, { save: false }); loadComments(); }, t('Delete note'));
    row.append(text, el('span', 'row-tools'));
    row.lastChild.append(done, del);
    return row;
  }));
}
async function addComment() {
  const text = $('note-text').value.trim(); if (!text) return;
  const data = await call('comments', { action: 'add', time: ctx.state.playhead, text }, { save: false });
  if (data) { $('note-text').value = ''; loadComments(); }
}

// ------------------------------------------------------------------ script, sync, multicam
async function assemble() {
  const script = $('script-text').value.trim(); if (!script) return ctx.toast(t('Paste a script or outline first (one line per beat).'));
  const preview = await call('assemble', { script, dryRun: true }, { revision: true });
  if (!preview) return;
  const missing = preview.unmatched?.length ? `\n${t('Not found')}: ${preview.unmatched.map(u => `#${u.line}`).join(', ')}` : '';
  if (!confirm(t('Replace the timeline with {m} of {n} script lines?', { m: preview.matched, n: preview.lines }) + missing)) return;
  call('assemble', { script, smooth: true }, { revision: true, label: t('Rough cut from script') });
}
async function syncSources() {
  const data = await call('sync', { reference: 0 }, { label: t('Synced by sound') });
  if (!data) return;
  S.sync = data.sync; renderSync();
}
function renderSync() {
  const box = $('sync-result'); if (!box) return;
  if (!S.sync) { box.textContent = ''; return; }
  box.replaceChildren(...S.sync.sources.map(s => el('div', s.reference || s.reliable ? '' : 'bad',
    `${s.index + 1}. ${s.name}: ${s.reference ? t('reference') : s.offset != null ? `${s.offset > 0 ? '+' : ''}${s.offset.toFixed(2)} s · ${t('confidence')} ${s.confidence}` : t('skipped')}`)));
}
async function multicam() {
  if (ctx.state.project.sources.filter(s => !s.still).length < 2) return ctx.toast(t('Multicam needs two or more recordings of the same moment.'));
  if (ctx.state.clips.length && !confirm(t('Replace the timeline with a multicam edit (picture follows who is speaking)?'))) return;
  call('multicam', { minShot: Number($('mc-min').value) || 2.5, maxShot: Number($('mc-max').value) || 8 }, { revision: true, label: t('Multicam edit made') });
}

// ------------------------------------------------------------------ hand-off, proxies
async function exportTimeline(format) {
  if (!ctx.state.project?.plan && !ctx.state.clips.length) return;
  if (!(await ctx.save({ quiet: true }))) return;
  try {
    const { timelineExport: x } = await ctx.api(ctx.endpoint('export-timeline'), 'POST', { format, fps: Number($('handoff-fps').value) || 30 });
    const name = x.file.split(/[\\/]/).pop();
    const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([x.content], { type: x.mime })), download: name });
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 5000);
    ctx.toast(t('{f} saved: {n} (also in the project folder).', { f: format.toUpperCase(), n: name }));
  } catch (e) { ctx.toast(e.message); }
}
async function loadProxies() {
  if (!ctx.state.project) return;
  try { const { proxies } = await ctx.api(ctx.endpoint('proxies'), 'POST', { action: 'status' }); S.proxies = proxies; renderProxies(); } catch { /* optional */ }
}
function renderProxies() {
  const box = $('proxy-status'); if (!box || !S.proxies) return;
  const made = S.proxies.sources.filter(s => s.proxy).length, needed = S.proxies.sources.filter(s => s.recommended && !s.proxy).length;
  box.textContent = made ? t('{n} proxies in use for smooth playback.', { n: made }) : needed ? t('{n} heavy source(s) would play smoother with a proxy.', { n: needed }) : t('Your sources play fine without proxies.');
  $('proxy-remove').disabled = !made || ctx.busy();
}

// ------------------------------------------------------------------ wiring
export function render08() {
  if (!ctx?.state.project) return;
  renderOutline();
  const busy = ctx.busy();
  for (const id of ['outline-add', 'outline-suggest', 'fit-run', 'range-render', 'script-run', 'sync-run', 'mc-run', 'proxy-make']) if ($(id)) $(id).disabled = busy;
  const r = ctx.state.range ?? {};
  if ($('range-render')) $('range-render').textContent = r.in != null && r.out != null ? t('▷ Render {a}–{b}', { a: clock(r.in), b: clock(r.out) }) : t('▷ Render 15 s around the playhead');
  if ($('fit-now')) $('fit-now').textContent = t('now {d}', { d: clock(totalDuration(ctx.state.clips)) });
}
export function onTab08(tab) { if (tab === 'long') { loadComments(); loadProxies(); render08(); } }
export function reset08() { S.hits = null; S.comments = []; S.proxies = null; S.sync = null; renderHits(); renderComments(); renderSync(); if ($('proxy-status')) $('proxy-status').textContent = ''; }

export function initDirector08(context) {
  ctx = context;
  $('outline-add').onclick = addSection;
  $('outline-suggest').onclick = suggestSections;
  $('search-run').onclick = search;
  $('search-query').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); search(); } };
  $('fit-run').onclick = fit;
  $('range-render').onclick = renderPart;
  $('note-add').onclick = addComment;
  $('note-text').onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) addComment(); };
  $('script-run').onclick = assemble;
  $('sync-run').onclick = syncSources;
  $('mc-run').onclick = multicam;
  document.querySelectorAll('#handoff [data-format]').forEach(b => { b.onclick = () => exportTimeline(b.dataset.format); });
  $('proxy-make').onclick = async () => {
    const data = await call('proxies', { action: 'make', all: !S.proxies?.sources.some(s => s.recommended && !s.proxy), height: 540 }, { save: false, label: t('Making proxies…') });
    if (data?.proxies?.note) ctx.toast(data.proxies.note);
  };
  $('proxy-remove').onclick = async () => { await call('proxies', { action: 'remove' }, { save: false }); loadProxies(); };
}
