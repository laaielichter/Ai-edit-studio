// Director 0.9 editor features: LUTs + colour match (Style), stabilise + talking-head zooms + auto B-roll (Shot),
// music to length, audio repair and sound effects (Audio), stems + A/B compare (Export).
import { t } from './i18n.js';

const $ = id => document.getElementById(id);
let ctx;
const S = { luts: [], advice: null };

/** POST to a project action (revision-guarded when asked) and take over the returned project. */
async function call(action, body = {}, { label, revision = true, save = true } = {}) {
  const { state } = ctx;
  if (!state.project || ctx.busy()) return null;
  if (save && !(await ctx.save({ quiet: true }))) return null;
  state.pending = true; state.inflight++; ctx.updateChrome();
  try {
    const data = await ctx.api(ctx.endpoint(action), 'POST', revision ? { ...body, revision: state.project.revision } : body);
    if (data.project && !data.dryRun) { ctx.acceptProject(data.project); state.dirty = false; ctx.history.reset(ctx.snapshot()); ctx.fillOptions(); ctx.renderAll(); ctx.statusView(); ctx.pollSoon(); }
    if (label) ctx.status(label);
    return data;
  } catch (e) { if (e.code === 'REVISION_CONFLICT') ctx.conflict(); else ctx.toast(e.message); return null; }
  finally { state.pending = false; state.inflight--; ctx.updateChrome(); }
}
const selected = () => ctx.state.clips.filter(c => ctx.state.selection.has(c.id)).map(c => c.id);

// ------------------------------------------------------------------ look
async function loadLuts() {
  try { const data = await ctx.api('/api/studio/luts'); S.luts = data.luts; renderLuts(); } catch { /* optional */ }
}
function renderLuts() {
  const sel = $('lut-select'); if (!sel) return;
  const current = ctx.state.options.lut || '';
  const opts = [Object.assign(document.createElement('option'), { value: '', textContent: t('No LUT') }),
    ...S.luts.map(l => Object.assign(document.createElement('option'), { value: l.file, textContent: l.builtin ? t(l.name) : `${l.name} · ${t('mine')}` }))];
  if (current && !S.luts.some(l => l.file === current)) opts.push(Object.assign(document.createElement('option'), { value: current, textContent: current.split(/[\\/]/).pop() }));
  sel.replaceChildren(...opts); sel.value = current;
  const strength = ctx.state.options.lutStrength ?? 1;
  if (document.activeElement !== $('lut-strength')) $('lut-strength').value = String(strength);
  $('lut-strength-out').textContent = `${Math.round(strength * 100)}%`;
  $('lut-strength').disabled = !current;
}
async function importLut() {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.cube' });
  input.onchange = async () => {
    const file = input.files?.[0]; if (!file) return;
    try {
      const copied = await ctx.upload(file);
      const data = await ctx.api('/api/studio/luts', 'POST', { file: copied, name: file.name.replace(/\.cube$/i, '') });
      await loadLuts();
      ctx.setOption('lut', data.imported.file, { commit: true }); renderLuts();
      ctx.toast(t('LUT "{n}" imported and applied. Save to keep it.', { n: data.imported.name }));
    } catch (e) { ctx.toast(e.message); }
  };
  input.click();
}

// ------------------------------------------------------------------ audio
function renderRepair() {
  const r = ctx.state.options.audioRepair ?? {};
  if (!$('repair-hum')) return;
  if (document.activeElement !== $('repair-hum')) $('repair-hum').value = String(r.hum ?? 0);
  if (document.activeElement !== $('repair-denoise')) $('repair-denoise').value = String(r.denoise ?? 0);
  $('repair-denoise-out').textContent = `${Math.round(Number($('repair-denoise').value) * 100)}%`;
  $('repair-declick').checked = Boolean(r.declick); $('repair-declip').checked = Boolean(r.declip);
  const n = (ctx.state.options.sfx ?? []).length;
  $('sfx-count').textContent = n ? t('{n} in the edit', { n }) : '';
}
async function analyseSound() {
  $('repair-info').textContent = t('Listening…');
  const data = await call('audio-repair', { action: 'analyze' }, { revision: false });
  if (!data) { $('repair-info').textContent = ''; return; }
  S.advice = data;
  const s = data.suggestion;
  $('repair-info').textContent = s ? [s.hum && t('{h} Hz hum', { h: s.hum }), s.declip && t('clipping'), s.denoise && t('noise')].filter(Boolean).join(' · ') + (data.levelShots.length ? ` · ${t('{n} shots at a different level', { n: data.levelShots.length })}` : '') : t('Clean: nothing to repair.');
  if (s) { $('repair-hum').value = String(s.hum); $('repair-denoise').value = String(s.denoise); $('repair-declip').checked = s.declip; $('repair-denoise-out').textContent = `${Math.round(s.denoise * 100)}%`; }
}
function repairBody() {
  return { action: 'apply', hum: Number($('repair-hum').value), denoise: Number($('repair-denoise').value), declick: $('repair-declick').checked, declip: $('repair-declip').checked };
}

// ------------------------------------------------------------------ wiring
export function render09() {
  if (!ctx?.state.project) return;
  renderLuts(); renderRepair();
  const ids = selected(), shot = ctx.state.clips.find(c => c.id === ids[0]);
  if ($('shot-stabilize') && document.activeElement !== $('shot-stabilize')) $('shot-stabilize').value = String(shot?.stabilize ?? 0);
  if ($('shot-stabilize-out')) $('shot-stabilize-out').textContent = Number($('shot-stabilize').value) ? `${Math.round(Number($('shot-stabilize').value) * 100)}%` : t('off');
  const busy = ctx.busy();
  for (const id of ['words-speed', 'color-auto', 'color-match', 'tz-punch', 'tz-push', 'tz-broll', 'music-fit', 'repair-analyse', 'repair-apply', 'repair-level', 'sfx-auto', 'sfx-clear', 'compare-last']) if ($(id)) $(id).disabled = busy || !ctx.state.clips.length;
  if ($('color-match')) $('color-match').disabled ||= ids.length !== 1;
  if ($('music-fit')) $('music-fit').disabled ||= !ctx.state.options.music;
  if ($('compare-last')) $('compare-last').disabled ||= (ctx.state.project.exports ?? []).filter(e => e.format !== 'stems').length < 2;
}
export function onTab09(tab) { if (tab === 'style') loadLuts(); }

export function initDirector09(context) {
  ctx = context;
  // Look.
  $('lut-select').onchange = () => { ctx.setOption('lut', $('lut-select').value, { commit: true }); if (!$('lut-select').value) ctx.setOption('lutStrength', 1, { commit: true }); renderLuts(); };
  $('lut-strength').oninput = () => { $('lut-strength-out').textContent = `${Math.round(Number($('lut-strength').value) * 100)}%`; };
  $('lut-strength').onchange = () => ctx.setOption('lutStrength', Number($('lut-strength').value), { commit: true });
  $('lut-import').onclick = importLut;
  $('color-auto').onclick = () => call('color-match', { mode: 'auto', ...(selected().length > 1 ? { clips: selected() } : {}) }, { label: t('Auto colour applied') });
  $('color-match').onclick = () => { const ref = selected()[0]; if (ref) call('color-match', { mode: 'match', reference: ref }, { label: t('Shots matched to the selected shot') }); };
  // Shot: stabilise, zooms, B-roll.
  $('shot-stabilize').oninput = () => { const v = Number($('shot-stabilize').value); $('shot-stabilize-out').textContent = v ? `${Math.round(v * 100)}%` : t('off'); };
  $('shot-stabilize').onchange = () => { const ids = selected(); if (ids.length) ctx.edit([{ op: 'set', clips: ids, stabilize: Number($('shot-stabilize').value) }], t('Stabilise')); };
  const zoomClips = () => (selected().length ? { clips: selected() } : {});
  $('tz-punch').onclick = () => call('auto-zoom', { style: 'punch', ...zoomClips() }, { label: t('Zooms on emphasis') });
  $('tz-push').onclick = () => call('auto-zoom', { style: 'push', ...zoomClips() }, { label: t('Slow push-ins') });
  $('tz-broll').onclick = async () => { const d = await call('auto-broll', {}, { label: t('Auto B-roll') }); if (d && !d.placed) ctx.toast(t(d.note ?? 'No free spots found.')); else if (d) ctx.toast(t('{n} B-roll cutaway(s) placed ({m}).', { n: d.placed, m: t(d.method) })); };
  // Audio.
  $('music-fit').onclick = async () => { const d = await call('music-fit', {}, { label: t('Music fitted to the edit') }); if (d) ctx.toast(t('Music fitted: {m}. Your file is untouched.', { m: d.method })); };
  $('repair-analyse').onclick = analyseSound;
  $('repair-denoise').oninput = () => { $('repair-denoise-out').textContent = `${Math.round(Number($('repair-denoise').value) * 100)}%`; };
  $('repair-apply').onclick = () => call('audio-repair', repairBody(), { label: t('Audio repair applied') });
  $('repair-level').onclick = () => call('audio-repair', { ...repairBody(), levelShots: true }, { label: t('Shot levels evened out') });
  $('sfx-auto').onclick = async () => { const d = await call('sfx', { action: 'auto' }, { label: t('Sound effects added') }); if (d && !d.sfx.length) ctx.toast(t('No transitions, texts or punch-ins to put effects on yet.')); };
  $('sfx-clear').onclick = () => call('sfx', { action: 'clear' }, { label: t('Sound effects cleared') });
  // Words: speed pauses up instead of cutting them.
  $('words-speed').onclick = async () => {
    const d = await call('text-edit', { sourceIndex: Number($('words-source')?.value || 0), speedPauses: { min: 0.8, speed: 2 }, captions: true }, { label: t('Pauses sped up') });
    if (d?.stats) ctx.toast(t('{n} pauses play twice as fast ({s} s shorter).', { n: d.stats.spedUp ?? 0, s: d.stats.secondsSaved ?? 0 }));
  };
  // Export.
  $('compare-last').onclick = () => call('compare', { layout: 'side' }, { revision: false, label: t('Rendering the comparison…') });
  loadLuts();
}
