// Program/source playback for the browser monitor. Plays ORIGINAL sources clip by
// clip with two alternating <video> elements so cuts land close to the frame.
// Look, captions and titles are CSS approximations; the FFmpeg render is leading.
import { layout } from './edit-ops.js';
import { mapCaptions } from './captions.js';
import { t } from './i18n.js';

const LOOKS = {
  neutral: { contrast: 1, saturate: 1, brightness: 0, gray: 0, warm: 0 },
  cinema: { contrast: 1.06, saturate: 0.92, brightness: -0.012, gray: 0, warm: -0.6 },
  vivid: { contrast: 1.04, saturate: 1.14, brightness: 0, gray: 0, warm: 0.3 },
  noir: { contrast: 1.1, saturate: 0, brightness: -0.008, gray: 1, warm: 0 },
};
export function cssLook(options = {}, clip = {}) {
  const look = LOOKS[options.look] ?? LOOKS.neutral, s = Number(options.lookStrength ?? 0.7);
  const contrast = (1 + (look.contrast - 1) * s) * Number(clip.contrast ?? 1), saturate = (1 + (look.saturate - 1) * s) * Number(clip.saturation ?? 1);
  const brightness = 1 + (look.brightness * s + Number(options.exposure ?? 0) + Number(clip.brightness ?? 0)) * 2.2;
  const hue = look.warm * s * 4 - Number(clip.temperature ?? 0) * 12;
  const sepia = Math.max(0, Number(clip.temperature ?? 0)) * 0.25;
  return `contrast(${contrast.toFixed(3)}) saturate(${saturate.toFixed(3)}) brightness(${brightness.toFixed(3)})${look.gray ? ` grayscale(${s.toFixed(2)})` : ''}${hue ? ` hue-rotate(${hue.toFixed(1)}deg)` : ''}${sepia ? ` sepia(${sepia.toFixed(2)})` : ''}`;
}

export class Player {
  constructor({ videos, music, narration, stage, overlays, mediaUrl, onTime, onState, onClipChange }) {
    Object.assign(this, { videos, music, narration, stage, overlays, mediaUrl, onTime, onState, onClipChange });
    this.rows = []; this.options = {}; this.cues = [];
    this.mode = 'program'; this.time = 0; this.playing = false; this.rate = 1;
    this.active = 0; this.current = -1; this.liveLook = true; this.liveMusic = true;
    this.source = { index: 0, duration: 0 };
    this.loop = this.loop.bind(this);
    this.bg = stage.querySelector('#stage-bg');
    this.img = stage.querySelector('#stage-img');
    this.still = null; // { row, startedAt, base } while a still image is on screen
    videos.forEach(v => v.addEventListener('seeked', () => this.drawBg()));
    videos.forEach(v => { v.muted = false; v.addEventListener('error', () => this.onState?.({ error: t('The browser cannot play this source format. A rendered preview (MP4) does work.') })); });
  }
  get video() { return this.videos[this.active]; }
  get standby() { return this.videos[1 - this.active]; }
  get duration() { return this.mode === 'program' ? (this.rows.at(-1)?.timelineEnd ?? 0) : this.source.duration; }

  setSequence(clips, options, sources) {
    const oldRows = this.rows;
    this.rows = layout(clips); this.options = options ?? {}; this.sources = sources ?? [];
    const was = oldRows[this.current], now = this.rows[this.current];
    const same = was && now && was.id === now.id && was.sourceIndex === now.sourceIndex && was.start === now.start && was.end === now.end && (was.speed ?? 1) === (now.speed ?? 1);
    // Same clip, same footage: keep playing and just refresh look, volume and framing.
    if (this.mode === 'program' && same) { this.video.volume = this.volumeFor(now); this.video.muted = this.volumeFor(now) === 0; this.transform(this.video, now); this.video.style.filter = this.liveLook ? cssLook(this.options, now) : 'none'; }
    this.cues = mapCaptions(this.options.captions ?? [], clips, Number(this.options.captionOffset) || 0);
    const musicUrl = this.options.music ? this.mediaUrl('music', 0) : '';
    if (musicUrl && !this.music.src.endsWith(musicUrl)) { this.music.src = musicUrl; this.music.loop = true; }
    if (!musicUrl && this.music.src) { this.music.pause(); this.music.removeAttribute('src'); this.music.load(); }
    const narrationUrl = this.options.narration ? this.mediaUrl('narration', 0) : '';
    if (narrationUrl && !this.narration.src.endsWith(narrationUrl)) this.narration.src = narrationUrl;
    if (!narrationUrl && this.narration.src) { this.narration.pause(); this.narration.removeAttribute('src'); this.narration.load(); }
    if (this.mode === 'program') {
      if (this.time > this.duration) this.time = Math.max(0, this.duration - 0.01);
      if (!this.playing) this.seek(this.time, { quiet: true });
      else if (!same) this.current = -1; // re-resolved on the next animation frame
    }
    this.applyLook();
  }

  applyLook() {
    const row = this.rows[this.current];
    const filter = this.liveLook && this.mode === 'program' ? cssLook(this.options, row ?? {}) : 'none';
    for (const v of this.videos) v.style.filter = filter;
  }

  setMode(mode, sourceIndex = this.source.index) {
    this.pause();
    this.mode = mode;
    if (mode === 'source') {
      const s = this.sources?.[sourceIndex];
      if (!s) return;
      this.source = { index: sourceIndex, duration: s?.duration ?? 0, time: this.source.index === sourceIndex ? this.source.time ?? 0 : 0 };
      if (s.still) {
        for (const v of this.videos) v.classList.add('hidden-video');
        if (this.img) { this.img.src = new URL(this.mediaUrl('source', sourceIndex), location.href).href; this.img.hidden = false; this.img.style.filter = 'none'; this.transform(this.img, null); }
        this.still = { row: null, startedAt: performance.now(), base: this.source.time };
      } else {
        this.still = null; if (this.img) this.img.hidden = true;
        this.load(this.video, this.mediaUrl('source', sourceIndex), this.source.time, null);
        this.standby.classList.add('hidden-video'); this.video.classList.remove('hidden-video');
      }
      this.transform(this.video, null); this.video.playbackRate = 1; this.video.volume = 1; this.video.muted = false;
      this.time = this.source.time;
    } else {
      this.current = -1; this.seek(this.time, { quiet: true });
    }
    this.applyLook(); this.overlay(this.time); this.drawBg();
    this.onTime?.(this.time);
  }

  /** Play any served MP4 (e.g. a finished export) in source mode. */
  openUrl(url, onReady) {
    this.pause(); this.mode = 'source'; this.still = null; if (this.img) this.img.hidden = true;
    this.source = { index: -1, duration: 0, time: 0, url };
    this.load(this.video, url, 0, () => { this.source.duration = this.video.duration || 0; onReady?.(); this.onTime?.(0); });
    this.standby.classList.add('hidden-video'); this.video.classList.remove('hidden-video');
    this.transform(this.video, null); this.video.playbackRate = 1; this.video.volume = 1; this.video.muted = false;
    for (const v of this.videos) v.style.opacity = '1';
    this.applyLook(); this.overlay(0); this.drawBg();
  }

  load(video, url, time, onReady) {
    const absolute = new URL(url, location.href).href;
    const seek = () => { try { video.currentTime = Math.max(0, time); } catch { /* not seekable yet */ } onReady?.(); };
    if (video.src !== absolute) {
      video.src = absolute; video.dataset.url = absolute;
      video.addEventListener('loadedmetadata', seek, { once: true });
    } else if (video.readyState >= 1) seek();
    else video.addEventListener('loadedmetadata', seek, { once: true });
  }

  transform(video, clip) {
    if (!clip || clip.framing !== 'fill') { video.style.objectFit = 'contain'; video.style.transform = clip?.mirror ? 'scaleX(-1)' : ''; video.style.objectPosition = ''; video.style.transformOrigin = ''; return; }
    const fx = (clip.focusX ?? 0.5) * 100, fy = (clip.focusY ?? 0.5) * 100;
    video.style.objectFit = 'cover'; video.style.objectPosition = `${fx}% ${fy}%`;
    video.style.transformOrigin = `${fx}% ${fy}%`;
    const z0 = clip.zoom ?? 1, z1 = clip.zoomEnd ?? z0, flip = clip.mirror ? ' scaleX(-1)' : '';
    const ex = (clip.focusXEnd ?? clip.focusX ?? 0.5) * 100, ey = (clip.focusYEnd ?? clip.focusY ?? 0.5) * 100;
    video.style.transition = 'none';
    video.style.transform = `scale(${z0})${flip}`;
    const panning = ex !== fx || ey !== fy;
    if ((z1 !== z0 || panning) && this.playing) {
      const seconds = Math.max(0.05, ((clip.end - clip.start) / (clip.speed || 1)) / (this.rate || 1));
      // Smart-reframe pan: the crop eases from focus to focusEnd, like the render (smoothstep).
      requestAnimationFrame(() => {
        video.style.transition = `transform ${seconds.toFixed(2)}s linear, object-position ${seconds.toFixed(2)}s ease-in-out`;
        video.style.transform = `scale(${z1})${flip}`;
        if (panning) { video.style.objectPosition = `${ex}% ${ey}%`; video.style.transformOrigin = `${ex}% ${ey}%`; }
      });
    }
  }

  clipIndexAt(t) {
    const rows = this.rows; if (!rows.length) return -1;
    const i = rows.findIndex(r => t >= r.visibleStart - 1e-4 && t < r.visibleEnd - 1e-4);
    return i < 0 ? rows.length - 1 : i;
  }

  volumeFor(row) {
    const gain = (row?.gain ?? 1) * Number(this.options.gameGain ?? 1);
    return Math.max(0, Math.min(1, gain));
  }

  /** Show the frame at timeline (program) or source time without playing. */
  seek(t, { quiet = false } = {}) {
    if (this.mode === 'source') {
      this.time = Math.max(0, Math.min(t, this.source.duration - 0.01)); this.source.time = this.time;
      if (this.still) this.still = { ...this.still, startedAt: performance.now(), base: this.time };
      else { try { this.video.currentTime = this.time; } catch { /* metadata pending */ } }
      if (!quiet) this.onTime?.(this.time);
      return;
    }
    if (!this.rows.length) return;
    this.time = Math.max(0, Math.min(t, this.duration - 0.001));
    const i = this.clipIndexAt(this.time), row = this.rows[i];
    const sourceTime = row.start + (this.time - row.timelineStart) * (row.speed || 1);
    this.showClip(i, sourceTime);
    if (this.playing) this.syncAudio(true);
    this.overlay(this.time);
    if (!quiet) this.onTime?.(this.time);
  }

  showClip(i, sourceTime) {
    const row = this.rows[i];
    const url = new URL(this.mediaUrl('source', row.sourceIndex), location.href).href;
    if (this.sources?.[row.sourceIndex]?.still) {
      for (const v of this.videos) { v.pause(); v.classList.add('hidden-video'); }
      if (this.img) {
        if (this.img.src !== url) this.img.src = url;
        this.img.hidden = false; this.img.style.filter = this.liveLook ? cssLook(this.options, row) : 'none';
        this.transform(this.img, row);
      }
      this.still = { row, startedAt: performance.now(), base: sourceTime };
      if (this.current !== i) { this.current = i; this.onClipChange?.(i); }
      this.preload(i + 1);
      return;
    }
    this.still = null; if (this.img) this.img.hidden = true;
    let target = this.video;
    if (this.current !== i && this.standby.dataset.url === url && this.standby.dataset.clip === row.id) { this.active = 1 - this.active; target = this.video; }
    this.load(target, url, sourceTime, () => { if (this.playing && target === this.video) target.play().catch(() => {}); });
    target.dataset.clip = row.id ?? String(i);
    target.playbackRate = (row.speed || 1) * this.rate;
    target.volume = this.volumeFor(row); target.muted = this.volumeFor(row) === 0;
    this.transform(target, row);
    target.style.filter = this.liveLook ? cssLook(this.options, row) : 'none';
    target.classList.remove('hidden-video'); this.standby.classList.add('hidden-video');
    if (this.standby !== target) this.standby.pause();
    if (this.current !== i) { this.current = i; this.onClipChange?.(i); }
    this.preload(i + 1);
  }

  preload(i) {
    const row = this.rows[i]; if (!row || this.sources?.[row.sourceIndex]?.still) return;
    const v = this.standby;
    this.load(v, this.mediaUrl('source', row.sourceIndex), row.start, null);
    v.dataset.clip = row.id ?? String(i);
  }

  play(rate = 1) {
    if (!this.duration) return;
    this.rate = rate;
    if (this.mode === 'program' && this.time >= this.duration - 0.05) this.seek(0, { quiet: true });
    this.playing = true;
    if (this.still) {
      const row = this.rows[this.current];
      const base = this.mode === 'source' ? this.source.time : row ? row.start + (this.time - row.timelineStart) * (row.speed || 1) : this.still.base;
      this.still = { ...this.still, startedAt: performance.now(), base };
    }
    const row = this.rows[this.current];
    this.video.playbackRate = (this.mode === 'program' ? (row?.speed || 1) : 1) * rate;
    if (!this.still) this.video.play().catch(() => {});
    if (this.mode === 'program') this.syncAudio(true);
    cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(this.loop);
    this.onState?.({ playing: true });
  }
  pause() {
    this.playing = false; cancelAnimationFrame(this.raf);
    for (const v of this.videos) v.pause();
    this.music.pause(); this.narration.pause();
    this.onState?.({ playing: false });
  }
  toggle() { if (this.playing) this.pause(); else this.play(1); }

  syncAudio(force = false) {
    const t = this.time, o = this.options;
    if (this.liveMusic && o.music && this.music.src && this.rate === 1) {
      const d = this.music.duration || Infinity;
      const want = (Number(o.musicTrimStart || 0) + t) % d;
      this.music.volume = Math.max(0, Math.min(1, Number(o.musicGain ?? 0.24) * 1.6));
      if (force || Math.abs(this.music.currentTime - want) > 0.18) { try { this.music.currentTime = want; } catch { /* pending */ } }
      if (this.music.paused) this.music.play().catch(() => {});
    } else this.music.pause();
    if (this.liveMusic && o.narration && this.narration.src && this.rate === 1 && t >= Number(o.narrationStart || 0)) {
      const want = Number(o.narrationTrimStart || 0) + t - Number(o.narrationStart || 0);
      this.narration.volume = Math.max(0, Math.min(1, Number(o.narrationGain ?? 1)));
      if (want < (this.narration.duration || Infinity)) {
        if (force || Math.abs(this.narration.currentTime - want) > 0.2) { try { this.narration.currentTime = want; } catch { /* pending */ } }
        if (this.narration.paused) this.narration.play().catch(() => {});
      } else this.narration.pause();
    } else this.narration.pause();
  }

  loop() {
    if (!this.playing) return;
    const v = this.video;
    if (this.mode === 'source' && this.still) {
      this.time = Math.min(this.source.duration, this.still.base + (performance.now() - this.still.startedAt) / 1000 * this.rate); this.source.time = this.time;
      if ((this.sourceStop != null && this.time >= this.sourceStop) || this.time >= this.source.duration) { this.pause(); this.sourceStop = null; }
      this.onTime?.(this.time);
    } else if (this.mode === 'source') {
      this.time = v.currentTime; this.source.time = this.time;
      if (this.sourceStop != null && this.time >= this.sourceStop) { this.pause(); this.sourceStop = null; }
      if (v.ended) this.pause();
      this.onTime?.(this.time);
    } else if (this.still) {
      const row = this.rows[this.current];
      const elapsed = (performance.now() - this.still.startedAt) / 1000 * this.rate;
      const sourceTime = this.still.base + elapsed * (row.speed || 1);
      const switchAt = row.end - (row.overlapOut / 2) * (row.speed || 1);
      if (sourceTime >= switchAt) {
        if (this.current + 1 >= this.rows.length) { this.time = this.duration; this.pause(); this.onTime?.(this.time); return; }
        const next = this.rows[this.current + 1];
        this.time = next.visibleStart;
        this.showClip(this.current + 1, next.start + (next.overlapIn / 2) * (next.speed || 1));
        if (!this.still) this.video.play().catch(() => {});
      } else this.time = row.timelineStart + (sourceTime - row.start) / (row.speed || 1);
      this.syncAudio(false); this.overlay(this.time); this.onTime?.(this.time);
    } else {
      const row = this.rows[this.current];
      if (!row) {
        const i = this.clipIndexAt(this.time);
        if (i < 0 || this.time >= this.duration - 0.01) { this.pause(); return; }
        const r = this.rows[i];
        this.showClip(i, r.start + (this.time - r.timelineStart) * (r.speed || 1));
        if (!this.still) this.video.play().catch(() => {});
        this.raf = requestAnimationFrame(this.loop);
        return;
      }
      const t = row.timelineStart + Math.max(0, v.currentTime - row.start) / (row.speed || 1);
      const switchAt = row.end - (row.overlapOut / 2) * (row.speed || 1);
      if (v.currentTime >= switchAt - 0.012 || v.ended) {
        if (this.current + 1 >= this.rows.length) { this.time = this.duration; this.pause(); this.onTime?.(this.time); return; }
        const next = this.rows[this.current + 1];
        this.time = next.visibleStart;
        this.showClip(this.current + 1, next.start + (next.overlapIn / 2) * (next.speed || 1));
        if (!this.still) this.video.play().catch(() => {});
      } else this.time = Math.min(t, row.timelineEnd);
      this.syncAudio(false);
      this.overlay(this.time);
      if ((this.frameCount = (this.frameCount ?? 0) + 1) % 3 === 0) this.drawBg();
      this.onTime?.(this.time);
    }
    this.raf = requestAnimationFrame(this.loop);
  }

  /** Blurred fill behind 'fit' shots, as the vertical/social renders do. */
  drawBg() {
    const c = this.bg; if (!c) return;
    const v = this.video, row = this.mode === 'program' ? this.rows[this.current] : null;
    const want = this.mode === 'program' && row && row.framing !== 'fill' && v.videoWidth && Math.abs(c.clientWidth / Math.max(1, c.clientHeight) - v.videoWidth / v.videoHeight) > 0.05;
    c.hidden = !want; if (!want) return;
    if (c.width !== 64) { c.width = 64; c.height = Math.round(64 * c.clientHeight / Math.max(1, c.clientWidth)) || 36; }
    const ctx = c.getContext('2d'); const scale = Math.max(c.width / v.videoWidth, c.height / v.videoHeight);
    const w = v.videoWidth * scale, h = v.videoHeight * scale;
    try { ctx.drawImage(v, (c.width - w) / 2, (c.height - h) / 2, w, h); } catch { /* frame not ready */ }
  }
  resizeBg() { if (this.bg) { this.bg.width = 0; this.drawBg(); } }

  /** B-roll / picture-in-picture preview: one muted video element that follows the timeline. */
  layer(t) {
    const el = this.layerEl ??= this.stage.querySelector('#stage-layer');
    if (!el) return;
    const program = this.mode === 'program' && this.rows.length;
    const o = program ? (this.options.overlays ?? []).find(x => t >= x.at && t < x.at + (x.end - x.start)) : null;
    if (!o) { if (!el.hidden) { el.hidden = true; el.pause(); } return; }
    const url = new URL(this.mediaUrl('source', o.sourceIndex), location.href).href;
    if (el.src !== url) el.src = url;
    el.className = `stage-layer ${o.mode} ${o.position}`;
    el.style.setProperty('--layer-size', `${Math.round((o.size ?? 0.32) * 100)}%`);
    el.style.filter = this.liveLook ? cssLook(this.options, {}) : 'none';
    el.hidden = false;
    const want = o.start + (t - o.at);
    if (el.readyState >= 1 && Math.abs(el.currentTime - want) > (this.playing ? 0.3 : 0.04)) { try { el.currentTime = want; } catch { /* not seekable yet */ } }
    if (this.playing && el.paused) el.play().catch(() => {}); else if (!this.playing && !el.paused) el.pause();
  }

  overlay(t) {
    this.layer(t);
    const { title, caption, end, texts } = this.overlays, o = this.options;
    if (texts) {
      const program = this.mode === 'program' && this.liveLook && this.rows.length;
      const active = program ? (o.texts ?? []).filter(x => t >= x.start && t < x.end) : [];
      const key = active.map(x => `${x.start}|${x.text}|${x.style}|${x.position}`).join('\n');
      if (texts.dataset.key !== key) {
        texts.dataset.key = key;
        texts.replaceChildren(...active.map(x => { const n = document.createElement('div'); n.className = `ovtext ${x.style} ${x.position}`; n.textContent = x.text; return n; }));
      }
    }
    const program = this.mode === 'program' && this.liveLook && this.rows.length;
    title.hidden = !(program && o.title && t < 3); if (!title.hidden) title.textContent = o.title;
    const total = this.duration;
    end.hidden = !(program && o.endTitle && t >= Math.max(3, total - 3)); if (!end.hidden) end.textContent = o.endTitle;
    // Progress bar preview (rendered as an accent bar growing over the programme).
    const host = texts?.parentElement;
    if (host) {
      let bar = host.querySelector(':scope > .progressbar');
      if (program && (o.progressBar === 'bottom' || o.progressBar === 'top')) {
        if (!bar) { bar = document.createElement('div'); bar.className = 'progressbar'; host.append(bar); }
        bar.style.width = `${Math.min(100, 100 * t / Math.max(0.1, total))}%`;
        bar.style.top = o.progressBar === 'top' ? '0' : ''; bar.style.bottom = o.progressBar === 'top' ? '' : '0';
      } else bar?.remove();
    }
    const cue = program ? this.cues.find(c => t >= c.start && t < c.end) : null;
    caption.hidden = !cue;
    if (cue) {
      const anim = o.captionAnimation && o.captionAnimation !== 'none' ? o.captionAnimation : '';
      caption.className = `overlay-caption ${o.captionStyle || 'box'} ${o.captionPosition || 'low'}${anim ? ` anim ${anim}` : ''}${o.captionCase === 'upper' ? ' upper' : ''}`;
      if (!anim) {
        if (caption.dataset.text !== cue.text) { caption.replaceChildren(Object.assign(document.createElement('span'), { textContent: cue.text })); caption.dataset.text = cue.text; }
      } else {
        // Word-by-word preview, like the libass render: karaoke/highlight show the line, pop 2–3 words, words one.
        const words = cue.words?.length ? cue.words : [{ start: cue.start, end: cue.end, text: cue.text }];
        let active = words.findIndex((w, i) => t >= w.start && t < (words[i + 1]?.start ?? cue.end)); if (active < 0) active = 0;
        let shown = words.map((w, i) => i);
        if (anim === 'words') shown = [active];
        else if (anim === 'pop') { const size = this.vertical ? 2 : 3; const first = Math.floor(active / size) * size; shown = shown.slice(first, first + size); }
        const key = `${cue.start}|${anim}|${shown.join(',')}|${active}`;
        if (caption.dataset.text !== key) {
          caption.dataset.text = key;
          const line = document.createElement('span');
          for (const i of shown) { const w = document.createElement('b'); w.textContent = words[i].text; if (i === active) w.className = 'on'; line.append(w, ' '); }
          if (anim === 'pop' || anim === 'words') { line.classList.add('pop'); line.style.animation = 'none'; void line.offsetWidth; line.style.animation = ''; }
          caption.replaceChildren(line);
        }
      }
    }
    // Fades: approximate with opacity over the black stage.
    let alpha = 1;
    if (program) {
      const fi = Number(o.fadeIn || 0), fo = Number(o.fadeOut || 0);
      if (fi > 0 && t < fi) alpha = Math.min(alpha, t / fi);
      if (fo > 0 && t > total - fo) alpha = Math.min(alpha, Math.max(0, (total - t) / fo));
    }
    for (const v of this.videos) v.style.opacity = String(alpha);
  }
}
