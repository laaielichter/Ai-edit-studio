// Director 0.10 editor: compose music with the local music engine, or generate it online with your own key.
import { t } from './i18n.js';

const $ = id => document.getElementById(id);
let ctx, styles = [], providers = [], lastSeed = null;

async function loadStyles() {
  try {
    const data = await ctx.api('/api/studio/music/styles');
    styles = data.styles; providers = data.providers ?? [];
    const sel = $('mg-style'), keep = sel.value || 'pop';
    sel.replaceChildren(...styles.map(s => Object.assign(document.createElement('option'), { value: s.id, textContent: t(s.name), title: t(s.description) })));
    sel.value = styles.some(s => s.id === keep) ? keep : 'pop';
    const el = providers.find(p => p.id === 'elevenlabs');
    $('mg-key-state').textContent = el?.configured ? t('saved ✓') : '';
  } catch { /* the music engine needs a 0.10 server */ }
}
function drops() {
  const raw = $('mg-drops').value.trim();
  if (!raw || /^auto$/i.test(raw)) return 'auto';
  return raw.split(/[ ,;]+/).map(Number).filter(n => Number.isFinite(n) && n > 0);
}
async function call(body, label) {
  const { state } = ctx;
  if (!state.project || ctx.busy()) return null;
  if (!(await ctx.save({ quiet: true }))) return null;
  state.pending = true; state.inflight++; ctx.updateChrome();
  $('mg-info').textContent = label;
  try {
    const data = await ctx.api(ctx.endpoint('music'), 'POST', { ...body, revision: state.project.revision });
    if (data.project) { ctx.acceptProject(data.project); state.dirty = false; ctx.history.reset(ctx.snapshot()); ctx.fillOptions(); ctx.renderAll(); ctx.statusView(); }
    return data;
  } catch (e) { if (e.code === 'REVISION_CONFLICT') ctx.conflict(); else ctx.toast(e.message); $('mg-info').textContent = ''; return null; }
  finally { state.pending = false; state.inflight--; ctx.updateChrome(); }
}
async function compose(newSeed) {
  const seed = newSeed || lastSeed === null ? Math.floor(Math.random() * 1e6) : lastSeed;
  const d = await call({ action: 'compose', style: $('mg-style').value, mood: $('mg-mood').value || undefined, drops: drops(), ending: $('mg-ending').value, seed, stems: $('mg-stems').checked },
    t('Composing… (about 10 s per 30 s of music)'));
  if (!d) return;
  lastSeed = d.seed;
  const hits = (d.anchors ?? []).map(a => `${a.time.toFixed(1)} s${a.accent ? '*' : ''}`).join(', ');
  $('mg-info').textContent = t('{style} · {key} · {bpm} BPM · hits at {hits} · seed {seed}', { style: t(styles.find(s => s.id === d.style)?.name ?? d.style), key: d.key, bpm: Math.round(d.bpm), hits: hits || '—', seed: d.seed });
  ctx.toast(t('Music composed and placed under the edit. “New variation” makes another one; Ctrl+Z goes back.'));
}
export function renderMusic() {
  if (!ctx?.state.project || !$('mg-compose')) return;
  const busy = ctx.busy() || !ctx.state.clips.length;
  for (const id of ['mg-compose', 'mg-variation', 'mg-eleven']) $(id).disabled = busy;
}
export function onTabMusic(tab) { if (tab === 'audio' && !styles.length) loadStyles(); }
export function initMusic(context) {
  ctx = context;
  if (!$('mg-compose')) return;
  $('mg-compose').onclick = () => compose(false);
  $('mg-variation').onclick = () => compose(true);
  $('mg-style').onchange = () => { lastSeed = null; };
  $('mg-key-save').onclick = async () => {
    try { const d = await ctx.api('/api/studio/music/provider', 'POST', { provider: 'elevenlabs', apiKey: $('mg-key').value }); $('mg-key').value = ''; $('mg-key-state').textContent = d.provider?.configured ? t('saved ✓') : ''; ctx.toast(t(d.provider?.configured ? 'Key saved on this computer.' : 'Key removed.')); }
    catch (e) { ctx.toast(e.message); }
  };
  $('mg-eleven').onclick = async () => {
    const d = await call({ action: 'elevenlabs', style: $('mg-style').value, mood: $('mg-mood').value || undefined, drops: drops(), ending: $('mg-ending').value, prompt: $('mg-prompt').value.trim() || undefined },
      t('Generating online with ElevenLabs… (can take a minute)'));
    if (d) { $('mg-info').textContent = t('ElevenLabs track placed under the edit.'); ctx.toast(t('Online track placed. Fit it to the edit with “Fit music to the edit” if needed.')); }
  };
  loadStyles();
}
