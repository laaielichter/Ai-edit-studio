// Interactive multi-lane timeline: ruler, markers, V1 with filmstrip thumbnails,
// A1 loudness waveform, music with beat grid, captions. Pure view + gestures;
// every committed change is reported as edit operations.
import { layout, sourceRoom, LIMITS, formatTime } from './edit-ops.js';
import { t } from './i18n.js';

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
const SNAP_PX = 8;

export class Timeline {
  constructor(root, callbacks) {
    this.root = root; this.cb = callbacks;
    this.scroll = root.querySelector('#tracks-scroll'); this.tracks = root.querySelector('#tracks');
    this.ruler = root.querySelector('#ruler'); this.lanes = {
      markers: root.querySelector('#lane-markers'), video: root.querySelector('#lane-video'), audio: root.querySelector('#lane-audio'),
      music: root.querySelector('#lane-music'), text: root.querySelector('#lane-text') };
    this.playheadEl = root.querySelector('#playhead'); this.rangeEl = root.querySelector('#range'); this.dropEl = root.querySelector('#drop-indicator');
    this.pps = 40; this.tool = 'select'; this.snap = true; this.model = null; this.drag = null;
    this.bind();
  }

  get width() { return this.scroll.clientWidth; }
  x(t) { return 8 + t * this.pps; }
  t(x) { return Math.max(0, (x - 8) / this.pps); }
  pointerTime(e) { const r = this.tracks.getBoundingClientRect(); return this.t(e.clientX - r.left); }

  fit() { const clips = this.model?.clips ?? []; const total = clips.length ? layout(clips).at(-1).timelineEnd : 10; this.pps = Math.max(2, Math.min(400, (this.width - 40) / Math.max(1, total))); this.render(); return this.pps; }
  setZoom(pps, anchorTime) {
    const before = anchorTime != null ? this.x(anchorTime) - this.scroll.scrollLeft : 0;
    this.pps = Math.max(2, Math.min(400, pps)); this.render();
    if (anchorTime != null) this.scroll.scrollLeft = this.x(anchorTime) - before;
  }

  /** model: {clips, sources, total, playhead, selection:Set, beats, markers, cues, curves, music, range, issues:Set, flash:Set, stripUrl(i)} */
  render(model = this.model) {
    if (!model) return;
    this.model = model;
    const rows = layout(model.clips); this.rows = rows;
    const total = rows.at(-1)?.timelineEnd ?? 0; model.total = total;
    const width = Math.max(this.width, this.x(Math.max(total, 1)) + 160);
    this.tracks.style.width = `${width}px`;
    this.renderRuler(width);
    this.renderMarkers();
    this.renderVideo(rows);
    this.renderAudio(rows);
    this.renderMusic(total);
    this.renderText();
    this.renderPlayhead(model.playhead);
    this.renderRange();
    this.root.classList.toggle('blade', this.tool === 'blade');
  }

  renderRuler(width) {
    const step = STEPS.find(s => s * this.pps >= 70) ?? 60, minor = step / (step >= 1 ? 5 : 2);
    const nodes = [];
    for (let t = 0; this.x(t) < width; t += minor) {
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      const tick = el('div', major ? 'tick' : 'tick minor'); tick.style.left = `${this.x(t)}px`;
      if (major) tick.append(el('span', '', step < 1 ? formatTime(t, 2) : formatTime(t, 0)));
      nodes.push(tick);
    }
    for (const b of this.model.beats ?? []) { if (b > this.model.total + 0.5) break; const n = el('div', 'beat'); n.style.left = `${this.x(b)}px`; nodes.push(n); }
    this.ruler.replaceChildren(...nodes);
  }

  renderMarkers() {
    this.lanes.markers.replaceChildren(...(this.model.markers ?? []).map((m, i) => {
      const n = el('div', `marker ${m.color || ''}`); n.style.left = `${this.x(m.time)}px`;
      n.title = `${m.label || t('Marker')} · ${formatTime(m.time, 2)} · ${t('double-click to remove')}`;
      n.onclick = e => { e.stopPropagation(); this.cb.seek(m.time); };
      n.ondblclick = e => { e.stopPropagation(); this.cb.ops([{ op: 'remove_marker', index: i }], t('Marker removed')); };
      return n;
    }));
  }

  renderVideo(rows) {
    const m = this.model, lane = this.lanes.video;
    const h = Math.max(20, (lane.clientHeight || 62) - 6), thumbW = Math.round(h * 16 / 9);
    const extras = [];
    lane.replaceChildren(...rows.map(r => {
      const n = el('div', 'clip'); n.dataset.index = r.index; n.dataset.id = r.id ?? '';
      const visible = r.visibleEnd - r.visibleStart, vStart = r.start + (r.overlapIn / 2) * (r.speed || 1);
      const left = this.x(r.visibleStart), w = Math.max(3, visible * this.pps - 1);
      n.style.left = `${left}px`; n.style.width = `${w}px`;
      if (m.selection?.has(r.id)) n.classList.add('selected');
      if (m.flash?.has(r.id)) n.classList.add('flash');
      if (m.issues?.has(r.index)) n.classList.add('issue');
      const source = m.sources[r.sourceIndex];
      if (source?.strip && w > 24) {
        const thumbs = el('div', 'thumbs'), strip = source.strip, url = m.stripUrl(r.sourceIndex);
        const count = Math.min(60, Math.ceil(w / thumbW));
        for (let k = 0; k < count; k++) {
          const mid = vStart + Math.min(r.end - vStart - 0.01, ((k + 0.5) * thumbW / this.pps) * (r.speed || 1));
          const frame = Math.max(0, Math.min(strip.count - 1, Math.floor(mid / strip.interval)));
          const i = el('i'); i.style.width = `${thumbW}px`;
          i.style.backgroundImage = `url("${url}")`; i.style.backgroundSize = `${strip.count * thumbW}px 100%`; i.style.backgroundPosition = `${-frame * thumbW}px 0`;
          thumbs.append(i);
        }
        n.append(thumbs);
      }
      const name = `${r.index + 1}${r.label ? ` · ${r.label}` : ''}`;
      n.append(el('span', 'label', w > 40 ? `${name} · ${r.duration.toFixed(1)}s` : String(r.index + 1)));
      const graded = ['brightness', 'contrast', 'saturation', 'temperature', 'sharpen', 'denoise'].some(k => r[k] !== undefined && r[k] !== false && r[k] !== (k === 'contrast' || k === 'saturation' ? 1 : 0));
      if ((r.speed ?? 1) !== 1 || (r.framing === 'fill') || r.mirror || graded) n.append(el('span', 'badge', [(r.speed ?? 1) !== 1 ? `${r.speed}×` : '', r.framing === 'fill' ? '⛶' : '', r.mirror ? '⇋' : '', graded ? '◐' : ''].filter(Boolean).join(' ')));
      if (r.overlapIn > 0) { const tr = el('div', 'transition', '⧓'); tr.style.left = `${this.x(r.timelineStart)}px`; tr.style.width = `${Math.max(8, r.overlapIn * this.pps)}px`; tr.title = t('Transition {tr} · {s} s · click the shot on the right to change it', { tr: r.transition, s: r.overlapIn.toFixed(2) }); extras.push(tr); }
      const energy = m.curves?.[r.sourceIndex]?.energy;
      if (energy) {
        const bar = el('div', 'energy'); const stops = [];
        const n2 = 12; for (let k = 0; k < n2; k++) {
          const st = r.start + (r.end - r.start) * (k + 0.5) / n2; const e = energy[Math.floor(st / 0.5)] ?? 0;
          stops.push(`hsl(${Math.round(200 - e * 160)} 70% ${35 + e * 25}%) ${(k / n2 * 100).toFixed(1)}% ${((k + 1) / n2 * 100).toFixed(1)}%`);
        }
        bar.style.background = `linear-gradient(90deg, ${stops.join(',')})`; n.append(bar);
      }
      n.title = `${t('Shot')} ${r.index + 1}${r.label ? ` (${r.label})` : ''} · ${source?.name ?? ''} ${formatTime(r.start, 2)}–${formatTime(r.end, 2)} · ${r.duration.toFixed(2)} s\n${t('Drag to move · edges to trim · Alt+drag = slip')}`;
      const l = el('div', 'handle l'), rr = el('div', 'handle r'); l.dataset.handle = 'start'; rr.dataset.handle = 'end';
      n.append(l, rr);
      return n;
    }));
    lane.append(...extras);
    if (!rows.length) lane.append(el('div', 'empty-timeline', t('No edit yet — make a proposal or insert a source from the source monitor.')));
  }

  renderAudio(rows) {
    const m = this.model;
    this.lanes.audio.replaceChildren(...rows.map(r => {
      const n = el('div', `aclip${(r.gain ?? 1) === 0 ? ' muted' : ''}`);
      n.style.left = `${this.x(r.visibleStart)}px`; n.style.width = `${Math.max(3, (r.visibleEnd - r.visibleStart) * this.pps - 1)}px`;
      const loud = m.curves?.[r.sourceIndex]?.loudness;
      if (loud && m.sources[r.sourceIndex]?.hasAudio) {
        const w = Math.max(3, r.duration * this.pps - 1), samples = Math.max(2, Math.min(240, Math.floor(w / 3)));
        let d = '';
        for (let k = 0; k < samples; k++) {
          const st = r.start + (r.overlapIn / 2) * (r.speed || 1) + (r.visibleEnd - r.visibleStart) * (r.speed || 1) * k / samples; const db = loud[Math.floor(st / 0.5)];
          const amp = db == null ? 0 : Math.max(0, Math.min(1, (db + 60) / 54)) * Math.min(1.4, (r.gain ?? 1));
          const x = (k / samples * 100).toFixed(2), hh = (amp * 46).toFixed(1);
          d += `M${x} ${50 - hh}V${50 + Number(hh)}`;
        }
        n.innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none"><path d="${d}" stroke="var(--audio-wave)" stroke-width="0.6" vector-effect="non-scaling-stroke" fill="none"/></svg>`;
      } else if (!m.sources[r.sourceIndex]?.hasAudio) n.append(el('span', 'gain', t('no audio')));
      if ((r.gain ?? 1) !== 1) n.append(el('span', 'gain', `${Math.round((r.gain ?? 1) * 100)}%`));
      return n;
    }));
  }

  renderMusic(total) {
    const m = this.model, lane = this.lanes.music;
    if (!m.music || !total) { lane.replaceChildren(); return; }
    const n = el('div', 'mclip', `♫ ${m.music.name}${m.music.bpm ? ` · ${m.music.bpm} BPM` : ''}`);
    n.style.left = `${this.x(0)}px`; n.style.width = `${total * this.pps}px`;
    (m.beats ?? []).forEach((b, i) => {
      if (b > total) return;
      const tick = el('i', `beat${(i - (m.music.downbeatIndex ?? 0)) % 4 === 0 ? ' down' : ''}`); tick.style.left = `${b * this.pps}px`; n.append(tick);
    });
    lane.replaceChildren(n);
  }

  renderText() {
    const texts = (this.model.texts ?? []).map((item, i) => {
      const n = el('div', 'tblock', `T ${item.text}`); n.style.left = `${this.x(item.start)}px`; n.style.width = `${Math.max(3, (item.end - item.start) * this.pps - 1)}px`; n.title = `${item.text} · ${formatTime(item.start, 1)}–${formatTime(item.end, 1)}`;
      n.onclick = e => { e.stopPropagation(); this.cb.seek(item.start + 0.01); this.cb.focusText?.(i); };
      return n;
    });
    this.lanes.text.replaceChildren(...texts, ...(this.model.cues ?? []).map(c => {
      const n = el('div', 'cue-block', c.text); n.style.left = `${this.x(c.start)}px`; n.style.width = `${Math.max(3, (c.end - c.start) * this.pps - 1)}px`; n.title = c.text;
      n.onclick = e => { e.stopPropagation(); this.cb.seek(c.start); };
      return n;
    }));
  }

  renderPlayhead(t = 0) {
    this.model && (this.model.playhead = t);
    this.playheadEl.style.left = `${this.x(t)}px`;
  }
  follow(t) {
    const x = this.x(t), left = this.scroll.scrollLeft, w = this.width;
    if (x > left + w - 60 || x < left + 20) this.scroll.scrollLeft = Math.max(0, x - w * 0.25);
  }
  renderRange() {
    const r = this.model.range;
    this.rangeEl.hidden = !(r && r.in != null && r.out != null && r.out > r.in);
    if (!this.rangeEl.hidden) { this.rangeEl.style.left = `${this.x(r.in)}px`; this.rangeEl.style.width = `${(r.out - r.in) * this.pps}px`; }
  }

  snapTargets(excludeIndex = -1) {
    const m = this.model, targets = [m.playhead];
    for (const r of this.rows) { if (r.index !== excludeIndex) targets.push(r.timelineStart, r.timelineEnd); }
    for (const mk of m.markers ?? []) targets.push(mk.time);
    for (const b of m.beats ?? []) targets.push(b);
    return targets;
  }
  snapTime(t, excludeIndex) {
    if (!this.snap) return { t, snapped: false };
    let best = null;
    for (const s of this.snapTargets(excludeIndex)) { const d = Math.abs(s - t) * this.pps; if (d <= SNAP_PX && (!best || d < best.d)) best = { s, d }; }
    return best ? { t: best.s, snapped: true } : { t, snapped: false };
  }
  showSnap(t) {
    this.tracks.querySelector('.snap-line')?.remove();
    if (t == null) return;
    const line = el('div', 'snap-line'); line.style.left = `${this.x(t)}px`; this.tracks.append(line);
  }

  bind() {
    // Scrub on the ruler (and empty lane areas).
    const scrub = e => {
      const move = ev => { const { t } = this.snapTime(this.pointerTime(ev)); this.cb.seek(Math.min(t, this.model?.total ?? 0)); };
      move(e);
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    };
    this.ruler.addEventListener('pointerdown', e => { e.preventDefault(); scrub(e); });
    for (const lane of Object.values(this.lanes)) lane.addEventListener('pointerdown', e => { if (e.target === lane) { e.preventDefault(); this.cb.clearSelection?.(); scrub(e); } });

    this.lanes.video.addEventListener('pointerdown', e => {
      const clipEl = e.target.closest('.clip'); if (!clipEl || e.button !== 0) return;
      e.preventDefault();
      const index = Number(clipEl.dataset.index), row = this.rows[index];
      const at = this.pointerTime(e);
      if (this.tool === 'blade') { this.cb.ops([{ op: 'split', at: this.snapTime(at).t }], t('Cut')); return; }
      const handle = e.target.dataset.handle;
      const startX = e.clientX;
      const original = this.model.clips.map(c => ({ ...c }));
      const room = sourceRoom(original, index, this.model.sources);
      let mode = handle ? `trim-${handle}` : e.altKey ? 'slip' : 'pending', result = null;
      if (mode !== 'pending') clipEl.classList.add('trimming');
      const move = ev => {
        const dx = ev.clientX - startX, dt = dx / this.pps, speed = row.speed || 1;
        if (mode === 'pending' && Math.abs(dx) > 4) { mode = 'move'; clipEl.classList.add('dragging'); }
        if (mode === 'trim-end') {
          let end = Math.min(row.end + room.after, Math.max(row.start + LIMITS.minSource, row.end + dt * speed));
          const snap = this.snapTime(row.timelineStart + (end - row.start) / speed, index);
          if (snap.snapped) end = Math.min(row.end + room.after, Math.max(row.start + LIMITS.minSource, row.start + (snap.t - row.timelineStart) * speed));
          this.showSnap(snap.snapped ? snap.t : null);
          result = { op: 'trim', clip: row.id ?? index, end: round(end) };
          this.cb.live(original.map((c, i) => i === index ? { ...c, end } : c));
          this.cb.peek?.(row.sourceIndex, end - 0.04);
        } else if (mode === 'trim-start') {
          const start = Math.max(row.start - room.before, Math.min(row.end - LIMITS.minSource, row.start + dt * speed));
          result = { op: 'trim', clip: row.id ?? index, start: round(start) };
          this.cb.live(original.map((c, i) => i === index ? { ...c, start } : c));
          this.cb.peek?.(row.sourceIndex, start);
        } else if (mode === 'slip') {
          const by = Math.max(-room.before, Math.min(room.after, -dt * speed));
          result = { op: 'slip', clip: row.id ?? index, by: round(by) };
          this.cb.live(original.map((c, i) => i === index ? { ...c, start: c.start + by, end: c.end + by } : c));
          this.cb.peek?.(row.sourceIndex, row.start + by);
        } else if (mode === 'move') {
          clipEl.style.transform = `translateX(${dx}px)`;
          const tNow = this.pointerTime(ev);
          const others = this.rows.filter(r => r.index !== index);
          let to = others.filter(r => (r.timelineStart + r.timelineEnd) / 2 < tNow).length;
          const edge = to < others.length ? others[to].timelineStart : this.model.total;
          this.dropEl.hidden = false; this.dropEl.style.left = `${this.x(edge)}px`;
          result = to !== index ? { op: 'move', clip: row.id ?? index, to } : null;
        }
      };
      const up = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        clipEl.classList.remove('dragging', 'trimming'); clipEl.style.transform = ''; this.dropEl.hidden = true; this.showSnap(null);
        if (mode === 'pending') { this.cb.select(row.id ?? index, e.shiftKey || e.ctrlKey || e.metaKey); if (e.detail >= 2) this.cb.seek(at); return; }
        if (result) this.cb.ops([result], { 'trim-start': t('Start trimmed'), 'trim-end': t('End trimmed'), slip: 'Slip', move: t('Shot moved') }[mode], original);
        else this.cb.live(null);
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });

    this.scroll.addEventListener('wheel', e => {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); this.setZoom(this.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15), this.pointerTime(e)); this.cb.zoomed?.(this.pps); }
      else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.preventDefault(); this.scroll.scrollLeft += e.deltaY; }
    }, { passive: false });
  }
}
const round = n => Math.round(n * 1000) / 1000;
