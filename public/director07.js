// Director 0.7 editor features: clip finder, sound & motion (J/L cuts, punch-ins, speed ramps,
// freeze frames), layers (B-roll / picture-in-picture), voice & loudness, render QC, queue and recipes.
import { t } from './i18n.js';
import { formatTime, OVERLAY_MODES, OVERLAY_POSITIONS } from './edit-ops.js';

const $ = id => document.getElementById(id);
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
const option = (value, label) => Object.assign(el('option', '', label), { value });
let ctx;
const S = { clips: [], queue: null, recipes: [], run: null, runTimer: null };

async function serverCall(action, body = {}, { label, revision = true } = {}) {
  const { state } = ctx;
  if (!state.project || ctx.busy()) return null;
  if (!(await ctx.save({ quiet: true }))) return null;
  state.pending = true; state.inflight++; ctx.updateChrome();
  try {
    const data = await ctx.api(ctx.endpoint(action), 'POST', revision ? { ...body, revision: state.project.revision } : body);
    if (data.project) { ctx.acceptProject(data.project); state.dirty = false; ctx.history.reset(ctx.snapshot()); ctx.fillOptions(); ctx.renderAll(); ctx.statusView(); }
    if (label) ctx.status(label);
    return data;
  } catch (e) { if (e.code === 'REVISION_CONFLICT') ctx.conflict(); else ctx.toast(e.message); return null; }
  finally { state.pending = false; state.inflight--; ctx.updateChrome(); }
}
const selectedIds = () => ctx.state.clips.filter(c => ctx.state.selection.has(c.id)).map(c => c.id);

// ------------------------------------------------------------------ clip finder
function clipRequest(extra = {}) {
  return { count: Number($('clips-count').value) || 5, minSeconds: Number($('clips-min').value) || 15, maxSeconds: Number($('clips-max').value) || 60, platform: $('clips-platform').value, ...extra };
}
function renderClips() {
  const root = $('clips-list'); if (!root) return;
  $('clips-make').disabled = !S.clips.length || ctx.busy();
  root.replaceChildren(...S.clips.map(c => {
    const card = el('article', 'clip-card'), head = el('header');
    head.append(el('strong', '', `#${c.rank} · ${formatTime(c.start, 0)}–${formatTime(c.end, 0)} · ${Math.round(c.duration)} s`), el('span', 'score', String(c.score)));
    card.append(head, el('small', 'muted', `${t('hook')} ${c.hook} · ${t('energy')} ${c.energy}${c.speech != null ? ` · ${t('speech')} ${c.speech}` : ''}${c.complete ? ` · ${t('complete sentences')}` : ''}`));
    if (c.text) card.append(el('p', '', c.text));
    card.title = t('Click to watch this part in the source monitor');
    card.onclick = () => ctx.peekSource(c.sourceIndex, c.start);
    return card;
  }));
}
async function findClips() {
  if (!ctx.state.project?.analyzed) return ctx.toast(t('Analyse your sources first to find the strongest moments.'));
  $('clips-find').disabled = true; ctx.status(t('Finding the best clips…'));
  try { const data = await ctx.api(ctx.endpoint('find-clips'), 'POST', clipRequest()); S.clips = data.clips; renderClips(); ctx.status(t('{n} clips found ({m})', { n: data.clips.length, m: data.method })); }
  catch (e) { ctx.toast(e.message); } finally { $('clips-find').disabled = false; }
}
async function makeClips() {
  if (!confirm(t('Make {n} new projects (one per clip, vertical, with captions) and queue their renders?', { n: S.clips.length }))) return;
  $('clips-make').disabled = true;
  try {
    const data = await ctx.api(ctx.endpoint('find-clips'), 'POST', clipRequest({ create: true, render: true }));
    await ctx.refreshList();
    ctx.toast(t('{n} clip projects made; renders are in the queue.', { n: data.created.length }), data.created[0] ? [[t('Open clip 1'), () => ctx.openProject(data.created[0].projectId)]] : []);
    loadQueue();
  } catch (e) { ctx.toast(e.message); } finally { $('clips-make').disabled = false; }
}

// ------------------------------------------------------------------ layers (overlays)
function addLayer() {
  const { state } = ctx;
  const s = ctx.sources()[state.sourceIndex]; if (!s) return;
  const a = state.srcIn ?? ctx.player.time, b = state.srcOut ?? Math.min(s.duration, a + 3);
  if (b - a < 0.5) return ctx.toast(t('Choose an in/out range of at least 0.5 s (I and O).'));
  if (!state.clips.length) return ctx.toast(t('Make an edit first; layers sit above it.'));
  const pip = (s.video?.width ?? 16) / (s.video?.height ?? 9) < 1.2;
  if (ctx.edit([{ op: 'add_overlay', sourceIndex: state.sourceIndex, start: Math.round(a * 1000) / 1000, end: Math.round(b * 1000) / 1000, at: state.playhead, mode: pip ? 'pip' : 'full' }], t('Layer added'))) {
    state.srcIn = state.srcOut = null; ctx.switchTab('right', 'shot');
  }
}
function renderLayers() {
  const root = $('overlay-list'); if (!root) return;
  const rows = ctx.state.options.overlays ?? [];
  if (!rows.length) { root.replaceChildren(el('p', 'muted small', t('No layers yet.'))); return; }
  root.replaceChildren(...rows.map((o, index) => {
    const box = el('div', 'overlay-row');
    const name = ctx.sources()[o.sourceIndex]?.name ?? `#${o.sourceIndex + 1}`;
    const head = el('div', 'muted small', `${index + 1} · ${name} ${o.start.toFixed(1)}–${o.end.toFixed(1)} s → ${formatTime(o.at, 1)}`);
    head.style.cursor = 'pointer'; head.onclick = () => ctx.seek(o.at);
    const controls = el('div', 'controls');
    const mode = el('select'); mode.append(...Object.entries(OVERLAY_MODES).map(([k, v]) => option(k, t(v)))); mode.value = o.mode;
    const pos = el('select'); pos.append(...Object.entries(OVERLAY_POSITIONS).map(([k, v]) => option(k, t(v)))); pos.value = o.position; pos.disabled = o.mode === 'full';
    const size = el('select'); size.append(...[[0.22, t('Small')], [0.32, t('Medium')], [0.45, t('Large')]].map(([v, l]) => option(String(v), l))); size.value = String([0.22, 0.32, 0.45].reduce((a, b) => (Math.abs(b - o.size) < Math.abs(a - o.size) ? b : a))); size.disabled = o.mode === 'full';
    const sound = el('select'); sound.append(option('0', t('Muted')), option('0.5', t('Low sound')), option('1', t('Full sound'))); sound.value = String(o.gain >= 1 ? 1 : o.gain > 0 ? 0.5 : 0);
    const remove = el('button', 'ghost danger', '×'); remove.type = 'button'; remove.title = t('Remove layer');
    mode.onchange = () => ctx.edit([{ op: 'update_overlay', index, mode: mode.value }], t('Layer'));
    pos.onchange = () => ctx.edit([{ op: 'update_overlay', index, position: pos.value }], t('Layer'));
    size.onchange = () => ctx.edit([{ op: 'update_overlay', index, size: Number(size.value) }], t('Layer'));
    sound.onchange = () => ctx.edit([{ op: 'update_overlay', index, gain: Number(sound.value) }], t('Layer'));
    remove.onclick = () => ctx.edit([{ op: 'remove_overlay', index }], t('Layer removed'));
    controls.append(mode, pos, size, remove); box.append(head, controls, sound);
    return box;
  }));
}

// ------------------------------------------------------------------ shot: sound & motion
function renderShot() {
  const clip = ctx.state.clips.find(c => ctx.state.selection.has(c.id));
  const index = clip ? ctx.state.clips.indexOf(clip) : -1;
  const v = clip?.audioShift ?? 0;
  if ($('shot-audioShift') && document.activeElement !== $('shot-audioShift')) $('shot-audioShift').value = v;
  if ($('shot-audioShift-out')) $('shot-audioShift-out').textContent = `${v > 0 ? '+' : ''}${Number(v).toFixed(1)} s${v < 0 ? ' · J' : v > 0 ? ' · L' : ''}`;
  for (const id of ['shot-audioShift']) if ($(id)) $(id).disabled = !clip || index === 0 || ctx.busy();
  for (const id of ['shot-punch', 'shot-ramp']) if ($(id)) $(id).disabled = !clip || ctx.busy();
  if ($('shot-freeze')) $('shot-freeze').disabled = !ctx.state.clips.length || ctx.busy();
}

// ------------------------------------------------------------------ QC on export cards
export function decorateExport(card, item) {
  const acts = card.querySelector('.acts'); if (!acts) return;
  const badge = el('span', `qc-badge ${item.qc ? (item.qc.passed && item.qc.issues === 0 ? 'ok' : 'warn') : ''}`, item.qc ? `QC ${item.qc.score} · ${item.qc.loudness ?? '—'} LUFS` : '');
  if (item.qc) card.querySelector('small')?.after(badge);
  const btn = el('button', 'ghost', t('Check quality')); btn.type = 'button';
  btn.onclick = async () => {
    btn.disabled = true; ctx.status(t('Measuring loudness, black and frozen picture…'));
    try {
      const { qc } = await ctx.api(ctx.endpoint('qc'), 'POST', { exportId: item.id });
      ctx.toast(`QC ${qc.score}/100 · ${qc.loudness ?? '—'} LUFS · ${t('peak')} ${Number.isFinite(qc.truePeak) ? qc.truePeak.toFixed(1) : '—'} dB${qc.issues.length ? ` — ${qc.issues.map(i => i.message).slice(0, 2).join(' ')}` : ` — ${t('no problems found')}`}`, [], 12000);
      const { project } = await ctx.api(ctx.endpoint()); ctx.state.project.exports = project.exports; ctx.renderAll();
    } catch (e) { ctx.toast(e.message); } finally { btn.disabled = false; }
  };
  acts.append(btn);
}

// ------------------------------------------------------------------ queue + events
async function loadQueue() { try { const { queue } = await ctx.api('/api/studio/queue'); S.queue = queue; renderQueue(); } catch { /* optional */ } }
function renderQueue() {
  const root = $('queue-list'); if (!root || !S.queue) return;
  const names = new Map((ctx.state.projects ?? []).map(p => [p.id, p.name]));
  $('queue-count').textContent = S.queue.waiting.length ? t('{n} waiting', { n: S.queue.waiting.length }) : '';
  if (!S.queue.waiting.length) { root.replaceChildren(el('p', 'muted small', t('Nothing waiting. Renders that arrive while the engine is busy line up here.'))); return; }
  root.replaceChildren(...S.queue.waiting.map(j => {
    const row = el('div', 'queue-row'); row.append(el('span', '', `#${j.position} · ${j.kind === 'export' ? t('Render') : t('Auto-edit')} · ${names.get(j.projectId) ?? j.projectId.slice(0, 8)}`));
    const cancel = el('button', 'ghost', t('Cancel')); cancel.type = 'button';
    cancel.onclick = async () => { try { await ctx.api('/api/studio/queue', 'POST', { cancel: j.id }); loadQueue(); } catch (e) { ctx.toast(e.message); } };
    row.append(cancel); return row;
  }));
}
function listen() {
  if (!('EventSource' in window)) return;
  const source = new EventSource('/api/events');
  source.addEventListener('queue', e => { try { S.queue = JSON.parse(e.data).jobs; S.queue.busy = true; renderQueue(); } catch { /* ignore */ } });
  source.addEventListener('project', e => {
    try { const d = JSON.parse(e.data); if (d.id === ctx.state.project?.id && (d.revision !== ctx.state.project.revision || d.status !== ctx.state.project.status)) ctx.pollSoon(); } catch { /* ignore */ }
  });
}

// ------------------------------------------------------------------ recipes
async function loadRecipes() {
  try { const { recipes } = await ctx.api('/api/studio/recipes'); S.recipes = recipes; renderRecipes(); } catch { /* optional */ }
}
function renderRecipes() {
  const root = $('recipe-list'); if (!root) return;
  root.replaceChildren(...S.recipes.map(r => {
    const row = el('div', 'recipe-row'), text = el('div');
    text.append(el('strong', '', t(r.name)), el('small', '', t(r.description ?? '')));
    const run = el('button', 'secondary', t('Run')); run.type = 'button'; run.disabled = !ctx.state.project || ctx.busy();
    run.onclick = () => runRecipe(r);
    row.append(text, run); return row;
  }));
}
async function runRecipe(r) {
  if (!ctx.state.project) return;
  if (!(await ctx.save({ quiet: true }))) return;
  try {
    const { run } = await ctx.api('/api/studio/recipes/run', 'POST', { name: r.id, projectId: ctx.state.project.id, inputs: {} });
    S.run = { ...run, name: r.name, log: [] }; renderRun();
    clearInterval(S.runTimer);
    S.runTimer = setInterval(async () => {
      try {
        const { run: now } = await ctx.api(`/api/studio/recipes/runs/${run.id}`); S.run = now; renderRun();
        if (now.status !== 'running') { clearInterval(S.runTimer); ctx.toast(now.status === 'done' ? t('Recipe "{n}" finished.', { n: t(now.name) }) : t('Recipe stopped: {e}', { e: now.log.at(-1)?.error ?? '' })); ctx.refreshList(); }
      } catch { clearInterval(S.runTimer); }
    }, 1500);
  } catch (e) { ctx.toast(e.message); }
}
function renderRun() {
  const box = $('recipe-run'); if (!box || !S.run) return;
  box.hidden = false;
  const list = el('ol');
  for (const l of S.run.log ?? []) list.append(el('li', l.ok ? '' : 'bad', `${l.tool.replace('studio_', '')}: ${l.summary ?? l.error}`));
  box.replaceChildren(el('strong', '', `${t(S.run.name)} · ${S.run.status === 'running' ? t('step {s}/{n}', { s: S.run.step, n: S.run.steps }) : t(S.run.status)}`), list);
}

// ------------------------------------------------------------------ wiring
export function render07() {
  if (!ctx?.state.project) return;
  renderShot(); renderLayers(); renderClips();
  const lt = ctx.state.options.loudnessTarget;
  if ($('loudness-target') && document.activeElement !== $('loudness-target')) $('loudness-target').value = lt == null ? 'off' : String(lt);
  if ($('insert-layer')) $('insert-layer').disabled = ctx.busy() || !ctx.state.clips.length;
  $('recipe-list')?.querySelectorAll('button').forEach(b => { b.disabled = ctx.busy(); });
}
export function onTab07(tab) { if (tab === 'deliver') loadQueue(); if (tab === 'agent') loadRecipes(); }
export function reset07() { S.clips = []; S.run = null; clearInterval(S.runTimer); if ($('recipe-run')) $('recipe-run').hidden = true; renderClips(); }

export function initDirector07(context) {
  ctx = context;
  $('clips-find').onclick = findClips;
  $('clips-make').onclick = makeClips;
  $('insert-layer').onclick = addLayer;
  $('shot-audioShift').oninput = () => { const v = Number($('shot-audioShift').value); $('shot-audioShift-out').textContent = `${v > 0 ? '+' : ''}${v.toFixed(1)} s`; };
  $('shot-audioShift').onchange = () => ctx.edit([{ op: 'set', clips: selectedIds(), audioShift: Number($('shot-audioShift').value) }], t('Sound cut'));
  $('shot-punch').onclick = () => {
    const shots = ctx.state.clips.filter(c => ctx.state.selection.has(c.id)); if (!shots.length) return;
    const shortest = Math.min(...shots.map(c => (c.end - c.start) / (c.speed || 1)));
    const every = ctx.currentBeats().length > 4 ? { every: 2 } : { seconds: Math.max(0.8, Math.min(2, Math.floor(shortest / 2 * 10) / 10)) };
    ctx.edit([{ op: 'punch_in', clips: shots.map(c => c.id), zoom: 1.15, ...every }], t('Punch-in zooms'));
  };
  $('shot-ramp').onclick = () => { const id = selectedIds()[0]; if (id) ctx.edit([{ op: 'speed_ramp', clip: id, from: 1, to: 0.5, steps: 4 }], t('Speed ramp')); };
  $('shot-freeze').onclick = () => serverCall('freeze', { at: ctx.state.playhead, seconds: 1.5, zoomEnd: 1.12 }, { label: t('Freeze frame added') });
  $('loudness-target').onchange = () => ctx.setOption('loudnessTarget', $('loudness-target').value === 'off' ? null : Number($('loudness-target').value), { commit: true });
  listen(); loadQueue();
}
