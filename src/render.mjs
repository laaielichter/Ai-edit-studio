import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DATA_ROOT, StudioError, ensureDataRoot, safeResolveWithin, writeJsonAtomic } from './paths.mjs';
import { findFfmpegTools, inspectFfmpeg, verifyVideo, probeMedia, filterComplexFile, ffmpegInstallHint } from './ffmpeg.mjs';
import { runProcess } from './process.mjs';
import { normalizeFinish, normalizeTransform, normalizeTransition, colorFilter, gradeFilter } from './finishing.mjs';
import { audioRepairChain, SFX } from './polish.mjs';
import { overlapOf, normalizeTexts } from '../public/edit-ops.js';
import { normalizeCaptions, mapCaptions, toSrt } from '../public/captions.js';

export const PREVIEW_SIZES = Object.freeze({ landscape: '1280x720', vertical: '720x1280', square: '720x720', portrait: '720x900' });
function parseResolution(value, preview) {
  if (preview && !Object.values(PREVIEW_SIZES).includes(value)) return { width: 1280, height: 720 };
  const match = String(value ?? '2560x1440').match(/^(\d{3,5})x(\d{3,5})$/);
  if (!match) throw new StudioError('INVALID_RESOLUTION', `Invalid resolution: ${value}.`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 320 || height < 180 || width % 2 !== 0 || height % 2 !== 0) {
    throw new StudioError('INVALID_RESOLUTION', 'Resolution must be at least 320x180 and both dimensions must be even.');
  }
  if (width > 7680 || height > 4320) throw new StudioError('INVALID_RESOLUTION', 'Maximum output is 7680x4320.');
  return { width, height };
}

export function filterPath(value) {
  return path.resolve(value).replaceAll('\\', '/').replace(':', '\\:').replaceAll("'", "\\'");
}

function outputPartialPath(output) {
  const extension = path.extname(output) || '.mp4';
  return path.join(
    path.dirname(output),
    `.${path.basename(output, extension)}.${randomUUID()}.partial${extension}`,
  );
}

function encoderArguments(capabilities, preview, maxBytes, duration) {
  const targetKbps = maxBytes ? Math.min(2400, Math.max(180, Math.floor(maxBytes * 0.80 * 8 / duration / 1000 - 128))) : null;
  if (targetKbps) return ['-c:v', capabilities.nvencReady ? 'h264_nvenc' : 'libx264', '-preset', capabilities.nvencReady ? 'p5' : 'fast',
    '-b:v', `${targetKbps}k`, '-maxrate', `${targetKbps}k`, '-bufsize', `${targetKbps * 2}k`, '-profile:v', 'high'];
  if (capabilities.nvencReady) {
    return [
      '-c:v', 'h264_nvenc', '-preset', preview ? 'p4' : 'p7', '-tune', 'hq',
      '-rc', 'vbr', '-cq', preview ? '24' : '18', '-b:v', preview ? '8M' : '30M',
      '-maxrate', preview ? '16M' : '48M', '-bufsize', preview ? '32M' : '96M',
      '-spatial-aq', '1', '-temporal-aq', '1', '-profile:v', 'high',
    ];
  }
  if (capabilities.libx264) {
    return ['-c:v', 'libx264', '-preset', preview ? 'veryfast' : 'slow', '-crf', preview ? '24' : '18', '-profile:v', 'high'];
  }
  throw new StudioError('ENCODER_MISSING', 'FFmpeg has no working h264_nvenc or libx264 encoder.');
}

import { filterColors } from './render-colors.mjs';
export { filterColors };
import { buildAss, fontFamily } from './captions-ass.mjs';

/** Numeric-only drawtext styling for burned-in captions; no user text enters this string. */
export function captionDrawStyle(style = 'box', position = 'low', width = 1920, vertical = false, colors = {}) {
  const c = filterColors(colors);
  const y = { low: vertical ? 'h*0.66' : 'h*0.70', middle: '(h-text_h)/2', high: 'h*0.16' }[position] ?? 'h*0.70';
  if (style === 'bold') {
    const size = Math.max(18, Math.round(width / (vertical ? 13 : 22)));
    return `fontcolor=${c.text}:fontsize=${size}:borderw=${Math.max(3, Math.round(size / 9))}:bordercolor=black:shadowx=0:shadowy=${Math.round(size / 14)}:shadowcolor=black@0.55:y=${y}`;
  }
  if (style === 'minimal') {
    const size = Math.max(14, Math.round(width / (vertical ? 26 : 40)));
    return `fontcolor=white@0.95:fontsize=${size}:borderw=1:bordercolor=black@0.7:shadowx=2:shadowy=2:shadowcolor=black@0.6:y=${y}`;
  }
  const size = Math.max(16, Math.round(width / (vertical ? 23 : 32)));
  return `fontcolor=${c.text}:fontsize=${size}:borderw=2:bordercolor=black:box=1:boxcolor=${colors.primary ? c.primary : 'black'}@0.72:boxborderw=10:y=${y}`;
}

/** Numeric-only drawtext styling for timeline texts (title cards, lower thirds). */
export function textDrawStyle(style = 'title', position = 'center', width = 1920, vertical = false, colors = {}) {
  const c = filterColors(colors);
  const left = position.startsWith('left-');
  const x = left ? 'w*0.06' : '(w-text_w)/2';
  const y = { center: '(h-text_h)/2', low: vertical ? 'h*0.72' : 'h*0.76', high: 'h*0.12', 'left-low': vertical ? 'h*0.74' : 'h*0.78', 'left-high': 'h*0.10' }[position] ?? '(h-text_h)/2';
  // Portrait frames get ~25% larger type than their width alone would give, but never wider than the frame.
  const base = vertical ? width * 1.25 : width;
  if (style === 'big') return `fontcolor=${c.text}:fontsize=${Math.round(base / 11)}:borderw=${Math.round(base / 160)}:bordercolor=black:shadowx=0:shadowy=${Math.round(base / 200)}:shadowcolor=black@0.5:line_spacing=${Math.round(base / 120)}:x=${x}:y=${y}`;
  if (style === 'lower') return `fontcolor=${c.text}:fontsize=${Math.round(base / 36)}:box=1:boxcolor=${c.primary}@0.78:boxborderw=${Math.round(base / 110)}:line_spacing=6:x=${x}:y=${y}`;
  if (style === 'callout') {
    // Pop-up button: text on the accent colour (dark text on light accents), rounded by a wide box border.
    const hex = parseInt(c.accent.slice(2), 16), light = (0.299 * (hex >> 16) + 0.587 * ((hex >> 8) & 255) + 0.114 * (hex & 255)) / 255 > 0.6;
    return `fontcolor=${light ? '0x111111' : '0xFFFFFF'}:fontsize=${Math.round(base / 30)}:box=1:boxcolor=${c.accent}@0.96:boxborderw=${Math.round(base / 70)}:x=${x}:y=${y}`;
  }
  if (style === 'note') return `fontcolor=${c.accent}:fontsize=${Math.round(base / 48)}:box=1:boxcolor=black@0.55:boxborderw=${Math.round(base / 160)}:x=${x}:y=${y}`;
  return `fontcolor=${c.text}:fontsize=${Math.round(base / 20)}:borderw=${Math.max(2, Math.round(base / 400))}:bordercolor=black@0.7:shadowx=0:shadowy=${Math.round(base / 300)}:shadowcolor=black@0.5:line_spacing=${Math.round(base / 160)}:x=${x}:y=${y}`;
}

/**
 * Per-clip audio windows for J/L cuts. clip.audioShift moves the SOUND cut into that clip:
 * negative = J-cut (its sound starts early, under the previous picture), positive = L-cut (the previous
 * sound carries on). Only on hard cuts; the total programme length never changes.
 */
export function audioWindows(clips) {
  const shift = clips.map((c, i) => {
    const s = Number(c.audioShift) || 0;
    if (!i || !s || overlapOf(clips[i - 1], c) > 0) return 0;
    const lim = Math.min(clips[i - 1].duration, c.duration) - 0.25;
    if (lim <= 0) return 0;
    return Math.max(-lim, Math.min(lim, s), s < 0 ? -(c.start / (c.speed || 1)) : -Infinity);
  });
  return clips.map((c, i) => {
    const sp = c.speed || 1, sIn = shift[i], sOut = shift[i + 1] ?? 0;
    return { aStart: c.start + sIn * sp, aEnd: c.end + sOut * sp, duration: c.duration - sIn + sOut, shiftIn: sIn, shiftOut: sOut };
  });
}
const VOICE = {
  light: 'highpass=f=80,afftdn=nr=10:nf=-45,equalizer=f=3000:t=q:w=1.2:g=2,deesser=i=0.25,',
  strong: 'highpass=f=90,afftdn=nr=18:nf=-40:tn=1,equalizer=f=250:t=q:w=1:g=-2,equalizer=f=3200:t=q:w=1.2:g=3,deesser=i=0.45,acompressor=threshold=0.18:ratio=3:attack=5:release=90,',
};

export function buildFilter(plan, {
  width,
  height,
  fps,
  title,
  titleFile,
  fontFile,
  musicInputIndex,
  drawtext,
  labelFile, label, endTitleFile, endTitle, logoInputIndex, gameGain, musicGain, vertical, cinematic,
  finish = normalizeFinish(),
  captionFiles = [],
  narrationInputIndex = null, narrationStart = 0, narrationGain = 1,
  captionStyle = 'box', captionPosition = 'low', textFiles = [], colors = {}, assFile = null, fontsDir = null,
  logoPosition = 'top-left', logoScale = 0.13, logoOpacity = 1,
  voiceEnhance = 'off', loudnessTarget = null, overlays = [], overlayInputs = [], overlayAudioInputs = [],
  stage = 'full', programAudioInput = 1,
  lutFile = null, lutStrength = 1, progressBar = 'off', timeOffset = 0, programDuration = null, sfxInputIndex = null, audioRepair = null, legacyTemperature = false,
  masterLimiter = true,
  videoInputs = plan.clips.map((_, i) => i), audioInputs = plan.clips.map((_, i) => i),
}) {
  const lines = [];
  const windows = audioWindows(plan.clips);
  const starts = []; { let t = 0; plan.clips.forEach((clip, i) => { t -= i ? overlapOf(plan.clips[i - 1], clip) : 0; starts.push(t); t += clip.duration; }); }
  const frameAt = t => Math.round(t * fps + 1e-6);
  const frames = plan.clips.map((clip, i) => frameAt(starts[i] + clip.duration) - frameAt(starts[i]));
  // Stages: "full" = one pass. Long edits: "segment" renders a run of shots with the picture finishing
  // (grade, text, captions, layers, logo) in segment time, keeping its raw sound; "audio" is the finishing
  // pass that mixes the concatenated programme sound (input programAudioInput) while the picture is copied.
  if (stage === 'audio') {
    lines.push(`[${programAudioInput}:a:0]aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,asetpts=N/SR/TB[acat]`);
  } else {
  for (let index = 0; index < plan.clips.length; index += 1) {
    const clip = plan.clips[index];
    const transform = normalizeTransform(clip);
    const duration = Number(clip.duration).toFixed(3);
    const speed = clip.speed ?? 1;
    if (stage !== 'clipaudio') {
    let videoInput = `${videoInputs[index]}:v:0`;
    if (cinematic) {
      // Feather a three-frame temporal blend over the instrument area only.
      // The source-time cutoff excludes the exterior camera at the end.
      const cutoff = Math.max(0, 128 - clip.start).toFixed(3);
      lines.push(`[${videoInput}]format=yuv420p,setpts=PTS-STARTPTS,split=3[original${index}][smooth${index}][mask${index}]`);
      lines.push(`[smooth${index}]tmix=frames=3:weights='1 2 1'[temporal${index}]`);
      lines.push(`[mask${index}]trim=end_frame=1,geq=lum='180*clip((Y/H-0.51)/0.13,0,1)*clip((X/W-0.38)/0.12,0,1)*clip((1-X/W)/0.06,0,1)':cb=0:cr=0,loop=loop=-1:size=1:start=0,setpts=N/(${fps}*TB)[feather${index}]`);
      lines.push(`[original${index}][temporal${index}][feather${index}]maskedmerge=planes=1:enable='lt(t,${cutoff})'[clean${index}]`);
      videoInput = `clean${index}`;
    }
    if (clip.stabilize > 0 && clip.stabFile) {
      // Two-pass stabilisation: transforms measured on exactly this input range (same -ss/-t), smoothed per strength.
      lines.push(`[${videoInput}]vidstabtransform=input='${filterPath(clip.stabFile)}':smoothing=${Math.round(8 + 32 * clip.stabilize)}:optzoom=1:zoomspeed=0.2:interpol=bicubic:crop=black[stab${index}]`);
      videoInput = `stab${index}`;
    } else if (clip.stabilize > 0) {
      lines.push(`[${videoInput}]deshake=rx=${Math.round(16 + 32 * clip.stabilize)}:ry=${Math.round(16 + 32 * clip.stabilize)}:edge=mirror[stab${index}]`);
      videoInput = `stab${index}`;
    }
    const color = colorFilter(clip, { legacyTemperature });
    lines.push('[' + videoInput + ']setpts=(PTS-STARTPTS)/' + speed + (transform.mirror ? ',hflip' : '') + (color ? ',' + color : '') + '[timed' + index + ']');
    videoInput = 'timed' + index;
    if (transform.framing === 'fill') {
      const z0 = transform.zoom, z1 = transform.zoomEnd, zmax = Math.max(z0, z1);
      // Focus point, optionally panning (eased) from focusX/Y to focusXEnd/YEnd: smart reframe follows the action.
      const pan = (a, b, time) => a === b ? String(a) : `(${a}+(${(b - a).toFixed(4)})*(st(0,clip(${time}/${duration},0,1))*ld(0)*(3-2*ld(0))))`;
      const fx = pan(transform.focusX, transform.focusXEnd, 't'), fy = pan(transform.focusY, transform.focusYEnd, 't');
      const zfx = pan(transform.focusX, transform.focusXEnd, 'ot'), zfy = pan(transform.focusY, transform.focusYEnd, 'ot');
      if (z0 === z1) {
        lines.push(`[${videoInput}]trim=duration=${duration},fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=increase:force_divisible_by=2:flags=lanczos,scale=trunc(iw*${z0.toFixed(4)}/2)*2:trunc(ih*${z0.toFixed(4)}/2)*2:flags=lanczos,crop=${width}:${height}:x='(iw-ow)*${fx}':y='(ih-oh)*${fy}',setsar=1,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[vq${index}]`);
      } else {
        // Ken Burns: cover-scale to a canvas big enough for the largest zoom, then zoompan animates
        // zoom→zoomEnd over the clip around the focus point (ot = output time, restarts per clip).
        const cw = Math.round(width * zmax / 2) * 2, ch = Math.round(height * zmax / 2) * 2;
        const zoomExpr = `${z0.toFixed(4)}+(${z1.toFixed(4)}-${z0.toFixed(4)})*min(1,ot/${duration})`;
        lines.push(`[${videoInput}]trim=duration=${duration},fps=${fps},scale=${cw}:${ch}:force_original_aspect_ratio=increase:force_divisible_by=2:flags=lanczos,crop=${cw}:${ch}:x='(iw-ow)*${fx}':y='(ih-oh)*${fy}',zoompan=z='${zoomExpr}':x='(iw-iw/zoom)*${zfx}':y='(ih-ih/zoom)*${zfy}':d=1:s=${width}x${height}:fps=${fps},setsar=1,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[vq${index}]`);
      }
    } else if (vertical) {
      lines.push(`[${videoInput}]trim=duration=${duration},fps=${fps},settb=AVTB,setpts=PTS-STARTPTS,split=2[fg${index}][bg${index}]`);
      lines.push(`[bg${index}]scale=${width}:${height}:force_original_aspect_ratio=increase:flags=bilinear,crop=${width}:${height},gblur=sigma=28,eq=brightness=-0.15[blur${index}]`);
      lines.push(`[fg${index}]scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos[fit${index}]`);
      lines.push(`[blur${index}][fit${index}]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[vq${index}]`);
    } else {
      lines.push(`[${videoInput}]trim=duration=${duration},fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[vq${index}]`);
    }
    // Frame-exact placement: each shot gets exactly the frames between its rounded start and end on the
    // timeline, so cuts never drift from the plan (and from captions, voice and music) however many shots.
    lines.push(`[vq${index}]tpad=stop=-1:stop_mode=clone,trim=end_frame=${frames[index]},setpts=PTS-STARTPTS[v${index}]`);
    }
    if (clip.hasAudio) {
      // Timestamps are rebuilt from the sample count AFTER padding: a shot that runs into the end of
      // its recording is padded with silence, and padded frames must not carry a missing timestamp
      // into concat/acrossfade ("Invalid data found when processing input").
      lines.push(
        `[${audioInputs[index]}:a:0]atrim=duration=${(windows[index].aEnd - windows[index].aStart).toFixed(3)},asetpts=PTS-STARTPTS,atempo=${speed},aresample=48000:async=1:first_pts=0,aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=duration=${windows[index].duration.toFixed(3)},asetpts=N/SR/TB,afade=t=in:d=0.02,afade=t=out:st=${Math.max(0, windows[index].duration - 0.02).toFixed(3)}:d=0.02[a${index}]`,
      );
    } else {
      lines.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${windows[index].duration.toFixed(3)},asetpts=PTS-STARTPTS[a${index}]`);
    }
  }

  // Join clips: hard cuts are concatenated in groups; a transition crossfades the
  // accumulated programme with the next group (xfade/acrossfade), offset = timeline start of the incoming clip.
  const groups = [];
  plan.clips.forEach((clip, i) => {
    const overlap = i ? overlapOf(plan.clips[i - 1], clip) : 0;
    if (!i || overlap <= 0) { if (!i) groups.push({ indices: [i], overlap: 0 }); else groups.at(-1).indices.push(i); }
    else groups.push({ indices: [i], overlap, transition: normalizeTransition(clip).transition, offset: starts[i] });
  });
  const joined = groups.map((group, g) => {
    if (group.indices.length === 1) return { v: `v${group.indices[0]}`, a: `a${group.indices[0]}` };
    // Picture and sound are joined separately: each has its exact length (frames vs samples), and a joint
    // concat would pad every shot to the longer of the two and push all later cuts late. J/L cuts need it too.
    if (stage !== 'clipaudio') lines.push(`${group.indices.map(i => `[v${i}]`).join('')}concat=n=${group.indices.length}:v=1:a=0[gv${g}]`);
    lines.push(`${group.indices.map(i => `[a${i}]`).join('')}concat=n=${group.indices.length}:v=0:a=1[ga${g}]`);
    return { v: `gv${g}`, a: `ga${g}` };
  });
  let current = joined[0];
  for (let g = 1; g < groups.length; g++) {
    const { overlap, transition, offset } = groups[g];
    const f0 = frameAt(offset), f1 = frameAt(offset + overlap);
    if (stage !== 'clipaudio') lines.push(`[${current.v}][${joined[g].v}]xfade=transition=${transition}:duration=${((f1 - f0) / fps).toFixed(6)}:offset=${(f0 / fps).toFixed(6)}[xv${g}]`);
    lines.push(`[${current.a}][${joined[g].a}]acrossfade=d=${overlap.toFixed(3)}:c1=tri:c2=tri[xa${g}]`);
    current = { v: `xv${g}`, a: `xa${g}` };
  }
  if (stage === 'clipaudio') { lines.push(`[${current.a}]anull[aout]`); return `${lines.join(';\n')};\n`; }
  lines.push(`[${current.v}]null[vcat]`);
  lines.push(`[${current.a}]anull[acat]`);
  }
  const fadeIn = Math.min(finish.fadeIn, plan.actualDuration / 2);
  const fadeOut = Math.min(finish.fadeOut, plan.actualDuration / 2);
  const fadeOutStart = Math.max(0, plan.actualDuration - fadeOut).toFixed(3);
  if (stage !== 'audio') {
  // Layers above the edit: B-roll cutaways and picture-in-picture (graded with the programme, under text).
  let base = 'vcat';
  overlays.forEach((o, k) => {
    const d = Math.min(o.end - o.start, plan.actualDuration - o.at);
    if (!(d >= 0.1) || overlayInputs[k] == null) return;
    const fade = Math.min(o.fade ?? 0, d / 3);
    let chain = `[${overlayInputs[k]}:v:0]setpts=PTS-STARTPTS,trim=duration=${d.toFixed(3)},fps=${fps},`;
    let x = '0', y = '0';
    if (o.mode === 'full') chain += `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height},setsar=1,`;
    else {
      const w = Math.round(Math.min(0.9, (o.size ?? 0.32) * (height > width ? 1.6 : 1)) * width / 2) * 2, b = Math.max(2, Math.round(width / 320)), m = Math.round(Math.min(width, height) * 0.04);
      chain += `scale=${w}:-2:flags=lanczos,pad=iw+${b * 2}:ih+${b * 2}:${b}:${b}:color=white@0.9,setsar=1,`;
      const [py, px] = o.position === 'center' ? ['center', 'center'] : o.position.split('-');
      x = px === 'left' ? String(m) : px === 'right' ? `W-w-${m}` : '(W-w)/2';
      y = py === 'top' ? String(m) : py === 'bottom' ? `H-h-${m}` : '(H-h)/2';
    }
    chain += `format=yuva420p${fade > 0 ? `,fade=t=in:st=0:d=${fade.toFixed(3)}:alpha=1,fade=t=out:st=${(d - fade).toFixed(3)}:d=${fade.toFixed(3)}:alpha=1` : ''},setpts=PTS-STARTPTS+${o.at.toFixed(3)}/TB[ov${k}]`;
    lines.push(chain);
    lines.push(`[${base}][ov${k}]overlay=x=${x}:y=${y}:eof_action=pass:enable='between(t,${o.at.toFixed(3)},${(o.at + d).toFixed(3)})'[ob${k}]`);
    base = `ob${k}`;
  });
  let videoChain = `[${base}]null`;
  if (fadeIn > 0) videoChain += ',fade=t=in:st=0:d=' + fadeIn;
  if (fadeOut > 0) videoChain += ',fade=t=out:st=' + fadeOutStart + ':d=' + fadeOut;
  const grade = gradeFilter(finish);
  if (grade) videoChain += ',' + grade;
  else if (cinematic) videoChain += ',eq=brightness=-0.010:contrast=1.045:saturation=0.91:gamma=1.015,colorbalance=bs=0.012:rh=0.008,vignette=angle=PI/9';
  if (lutFile) {
    // 3D LUT (.cube) on the graded picture, under all text; strength < 1 blends with the ungraded picture.
    const s = Math.max(0, Math.min(1, Number(lutStrength) || 0));
    if (s >= 0.999) videoChain += `,lut3d=file='${filterPath(lutFile)}'`;
    else if (s > 0) {
      lines.push(`${videoChain},split=2[lutA][lutB]`);
      lines.push(`[lutB]lut3d=file='${filterPath(lutFile)}'[lutC]`);
      lines.push(`[lutC][lutA]blend=all_mode=normal:all_opacity=${s.toFixed(3)}[lutD]`);
      videoChain = '[lutD]null';
    }
  }
  if (title && drawtext) {
    const font = fontFile ? `fontfile='${filterPath(fontFile)}':` : '';
    const titleSize = Math.max(12, Math.min(width / 26, width * 0.88 / Math.max(1, title.length * 0.62)));
    const titleTiming = cinematic ? "alpha='min(1,t/0.6)*min(1,max(0,(4.5-t)/0.8))':enable='between(t,0,4.5)'" : "enable='between(t,0,3)'";
    videoChain += `,drawtext=${font}textfile='${filterPath(titleFile)}':expansion=none:fontcolor=white:fontsize=${titleSize.toFixed(1)}:borderw=3:bordercolor=black@0.65:x=${cinematic ? 'w*0.065' : '(w-text_w)/2'}:y=h*${cinematic ? '0.16' : '0.78'}:${titleTiming}`;
  }
  const font = fontFile ? `fontfile='${filterPath(fontFile)}':` : '';
  const captionLook = captionDrawStyle(captionStyle, captionPosition, width, vertical, colors);
  if (assFile) videoChain += `,ass=filename='${filterPath(assFile)}'${fontsDir ? `:fontsdir='${filterPath(fontsDir)}'` : ''}`;
  else for (const cue of captionFiles) {
    videoChain += `,drawtext=${font}textfile='${filterPath(cue.file)}':expansion=none:${captionLook}:x=(w-text_w)/2:enable='gte(t,${cue.start.toFixed(3)})*lt(t,${cue.end.toFixed(3)})'`;
  }
  for (const item of textFiles) {
    const fadeIn = Math.min(0.35, (item.end - item.start) / 3).toFixed(3);
    videoChain += `,drawtext=${font}textfile='${filterPath(item.file)}':expansion=none:${textDrawStyle(item.style, item.position, width, vertical, colors)}:alpha='min(1,(t-${item.start.toFixed(3)})/${fadeIn})*min(1,(${item.end.toFixed(3)}-t)/${fadeIn})':enable='gte(t,${item.start.toFixed(3)})*lt(t,${item.end.toFixed(3)})'`;
  }
  if (label && drawtext) videoChain += `,drawtext=${font}textfile='${filterPath(labelFile)}':expansion=none:fontcolor=${filterColors(colors).accent}:fontsize=w/52:box=1:boxcolor=black@0.5:boxborderw=10:x=w-text_w-w*0.04:y=h*0.04`;
  if (endTitle && drawtext) videoChain += `,drawtext=${font}textfile='${filterPath(endTitleFile)}':expansion=none:fontcolor=white:fontsize=${Math.max(12, Math.min(width / 28, width * 0.88 / Math.max(1, endTitle.length * 0.62))).toFixed(1)}:box=1:boxcolor=black@0.55:boxborderw=16:x=(w-text_w)/2:y=h*0.8:enable='gte(t,${Math.max(3, plan.actualDuration - 3).toFixed(3)})'`;
  if (logoInputIndex != null) {
    lines.push(`${videoChain}[branded]`);
    const scale = Math.max(0.05, Math.min(0.4, Number(logoScale) || 0.13)), opacity = Math.max(0.1, Math.min(1, Number(logoOpacity) || 1));
    const [ly, lx] = String(logoPosition).split('-');
    lines.push(`[${logoInputIndex}:v]scale=${Math.round(Math.min(width, height) * (vertical ? scale * 1.6 : scale * 16 / 9) / 2) * 2}:-2:force_original_aspect_ratio=decrease,format=rgba${opacity < 1 ? `,colorchannelmixer=aa=${opacity.toFixed(3)}` : ''}[logo]`);
    lines.push(`[branded][logo]overlay=x=${lx === 'right' ? 'W-w-W*0.04' : 'W*0.04'}:y=${ly === 'bottom' ? 'H-h-H*0.05' : 'H*0.04'}:shortest=1[vbar]`);
  } else lines.push(`${videoChain}[vbar]`);
  if (progressBar === 'top' || progressBar === 'bottom') {
    // Progress bar in programme time (segments pass their offset and the programme length).
    const T = Math.max(0.1, programDuration ?? plan.actualDuration), h = Math.max(4, Math.round(Math.min(width, height) / 120 / 2) * 2);
    lines.push(`color=c=${filterColors(colors).accent}:s=${width}x${h}:r=${fps},format=yuva420p,colorchannelmixer=aa=0.92[pbar]`);
    lines.push(`[vbar][pbar]overlay=x='-w+w*min(1,(t+${Number(timeOffset).toFixed(3)})/${T.toFixed(3)})':y=${progressBar === 'top' ? 0 : 'H-h'}:shortest=1,format=yuv420p[vout]`);
  } else lines.push('[vbar]null[vout]');
  }
  if (stage === 'segment') {
    lines.push('[acat]anull[aout]');
    return `${lines.join(';\n')};\n`;
  }
  let clipVolumes = '';
  plan.clips.forEach((clip, i) => {
    const from = starts[i] + (i ? overlapOf(plan.clips[i - 1], clip) / 2 : 0), to = starts[i] + clip.duration - (overlapOf(clip, plan.clips[i + 1]) / 2);
    if ((clip.gain ?? 1) !== 1) clipVolumes += `volume=${clip.gain}:enable='gte(t,${from.toFixed(3)})*lt(t,${to.toFixed(3)})',`;
  });
  // Apply editorial gains AFTER normalization so quieter and muted clips stay so.
  const channel = { stereo: '', left: 'pan=stereo|c0=c0|c1=c0,', right: 'pan=stereo|c0=c1|c1=c1,', mono: 'pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1,' }[finish.sourceChannel];
  // loudnorm/aresample can emit an initial NOPTS frame. Rebuild timestamps from
  // sample count, not STARTPTS, before timed volume, delay and cross-track mixing.
  lines.push(`[acat]${channel}${audioRepairChain(audioRepair)}${finish.reduceRumble && voiceEnhance === 'off' ? 'highpass=f=80,' : ''}${VOICE[voiceEnhance] ?? ''}loudnorm=I=-18:TP=-2:LRA=10,aresample=48000,asetpts=N/SR/TB,${clipVolumes}volume=${gameGain},acompressor=threshold=0.35:ratio=2:attack=10:release=100[game]`);
  const overlaySound = overlays.map((o, k) => ({ o, k })).filter(({ o, k }) => o.gain > 0 && overlayAudioInputs[k] != null);
  if (overlaySound.length) {
    lines.push('[game]anull[gamebed]');
    for (const { o, k } of overlaySound) {
      const d = Math.min(o.end - o.start, plan.actualDuration - o.at);
      lines.push(`[${overlayAudioInputs[k]}:a:0]atrim=duration=${d.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,volume=${o.gain},afade=t=in:d=0.05,afade=t=out:st=${Math.max(0, d - 0.05).toFixed(3)}:d=0.05,adelay=${Math.round(o.at * 1000)}:all=1,apad,atrim=duration=${plan.actualDuration.toFixed(3)},asetpts=N/SR/TB[oa${k}]`);
    }
    lines.push(`[gamebed]${overlaySound.map(({ k }) => `[oa${k}]`).join('')}amix=inputs=${overlaySound.length + 1}:duration=first:dropout_transition=0:normalize=0[game]`.replace('[game]', '[gamemix]'));
    lines.push('[gamemix]anull[game2]');
  }
  const gameOut = overlaySound.length ? 'game2' : 'game';
  if (narrationInputIndex != null) {
    // Place short voice tracks on the timeline BEFORE loudnorm's buffered EOF
    // flush; delaying afterwards loses leading silence in the tested FFmpeg build.
    lines.push(`[${narrationInputIndex}:a:0]aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,asetpts=N/SR/TB,afade=t=in:d=0.02,adelay=${Math.round(narrationStart * 1000)}:all=1,apad,atrim=duration=${plan.actualDuration.toFixed(3)},loudnorm=I=-16:TP=-2:LRA=9,aresample=48000,asetpts=N/SR/TB,volume=${narrationGain}[narration]`);
    lines.push(`[${gameOut}][narration]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[foreground]`);
  } else lines.push(`[${gameOut}]anull[foreground]`);
  if (sfxInputIndex != null) {
    // Sound effects (pre-mixed track) join the foreground before the master loudness.
    lines.push(`[${sfxInputIndex}:a:0]aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,asetpts=N/SR/TB,apad,atrim=duration=${plan.actualDuration.toFixed(3)}[sfx]`);
    lines.push('[foreground][sfx]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[fgsfx]');
    lines.push('[fgsfx]anull[foreground2]');
  }
  const fg = sfxInputIndex != null ? 'foreground2' : 'foreground';
  const master = Number.isFinite(loudnessTarget) ? `,loudnorm=I=${loudnessTarget}:TP=-1.5:LRA=11,aresample=48000` : '';
  const audioTail = master + (masterLimiter ? ',alimiter=limit=0.84:level=0' : '') + (fadeOut > 0 ? ',afade=t=out:st=' + fadeOutStart + ':d=' + fadeOut : '') + '[aout]';

  if (musicInputIndex != null) {
    lines.push(`[${musicInputIndex}:a:0]atrim=duration=${plan.actualDuration.toFixed(3)},aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS,loudnorm=I=-16:TP=-2:LRA=10,aresample=48000,asetpts=N/SR/TB,volume=${musicGain},afade=t=in:d=0.4[music]`);
    if (finish.duckMusic) {
      lines.push(`[${fg}]asplit=2[gameout][sidechain]`);
      lines.push('[music][sidechain]sidechaincompress=threshold=0.08:ratio=6:attack=20:release=350:makeup=1[ducked]');
      lines.push('[gameout][ducked]amix=inputs=2:duration=first:dropout_transition=2:normalize=0' + audioTail);
    } else lines.push(`[${fg}][music]amix=inputs=2:duration=first:dropout_transition=2:normalize=0` + audioTail);
  } else {
    lines.push(`[${fg}]anull` + audioTail);
  }
  return `${lines.join(';\n')};\n`;
}

/**
 * Segment boundaries for long edits: only at hard cuts (no transition overlap, no J/L shift) outside anything
 * that spans time, so finished segments concatenate without any change to the picture or sound. Boundaries
 * depend on clip ids, not on positions, so editing one part of a long timeline leaves the other segments
 * (and their cache files) untouched.
 */
export function segmentBoundaries(clips, { minSeconds = 30, maxSeconds = 90, maxClips = 36, blocked = [] } = {}) {
  const windows = audioWindows(clips);
  const mark = id => [...String(id ?? '')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 3 === 0;
  const segments = [];
  let cur = [0], dur = clips[0]?.duration ?? 0, end = clips[0]?.duration ?? 0;
  for (let i = 1; i < clips.length; i++) {
    const overlap = overlapOf(clips[i - 1], clips[i]), at = end - overlap;
    // Only at hard cuts, and never inside something that spans time (caption, text, layer, title, end).
    const free = overlap === 0 && !windows[i].shiftIn && !blocked.some(([a, b]) => a < at - 1e-3 && b > at + 1e-3);
    end = at + clips[i].duration;
    if (free && ((dur >= minSeconds && mark(clips[i - 1].id)) || dur >= maxSeconds || cur.length >= maxClips)) { segments.push(cur); cur = []; dur = 0; }
    dur += clips[i].duration - (cur.length ? overlap : 0);
    cur.push(i);
  }
  segments.push(cur);
  return segments;
}
const SEGMENT_VERSION = 'seg-v2';
/**
 * Inputs for a run of clips. Each clip gets its own video input and, when it has sound, its OWN audio-only
 * input (-vn): acrossfade drains a whole group's audio before it can crossfade, and with a shared demuxer
 * that would pull every video frame of the group into memory.
 * No -itsoffset: combined with -ss it shifts the seek point (FFmpeg seeks in the offset timeline and the
 * accurate-seek trim no longer drops the frames between the keyframe and the in-point), which showed the
 * wrong footage in 0.5–0.7. Measured without it: 1440p60 with dips to black stays around 600 MB.
 */
function pushClipInputs(args, clips, outputFps) {
  const windows = audioWindows(clips), videoInputs = [], audioInputs = [];
  const count = () => args.filter(x => x === '-i').length;
  for (const [i, clip] of clips.entries()) {
    const offset = [];
    const still = /\.(png|jpe?g|webp)$/i.test(clip.source);
    videoInputs.push(count());
    if (still) args.push('-protocol_whitelist', 'file,pipe', ...offset, '-loop', '1', '-framerate', String(outputFps), '-t', Number(clip.end - clip.start).toFixed(3), '-i', clip.source);
    else args.push('-protocol_whitelist', 'file,pipe', '-threads', '2', ...offset, '-ss', Number(clip.start).toFixed(3), '-t', Number(clip.end - clip.start).toFixed(3), '-i', clip.source);
    if (clip.hasAudio && !still) {
      audioInputs.push(count());
      const w = windows[i];
      args.push('-protocol_whitelist', 'file,pipe', '-vn', '-ss', Math.max(0, w.aStart).toFixed(3), '-t', (w.aEnd - Math.max(0, w.aStart)).toFixed(3), '-i', clip.source);
    } else audioInputs.push(videoInputs[i]);
  }
  return { videoInputs, audioInputs };
}
/** Locally synthesised sound effects, generated once into the data root. */
export async function ensureSfxLibrary(kinds, tools = findFfmpegTools()) {
  const dir = safeResolveWithin(DATA_ROOT, 'sfx');
  await fs.mkdir(dir, { recursive: true });
  const files = {};
  for (const kind of kinds) {
    if (!SFX[kind]) throw new StudioError('INVALID_SFX', `Unknown sound effect ${kind}.`);
    const file = path.join(dir, `${kind}-v1.wav`);
    if (!fsSync.existsSync(file)) {
      const partial = path.join(dir, `.${randomUUID()}.partial.wav`);
      try {
        await runProcess(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', SFX[kind].graph, '-t', String(SFX[kind].seconds), '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', partial], { timeoutMs: 60_000 });
        await fs.rename(partial, file);
      } catch (e) { await fs.rm(partial, { force: true }).catch(() => {}); throw new StudioError('SFX_FAILED', `Sound effect ${kind} could not be made: ${e.message}`, { cause: e }); }
    }
    files[kind] = file;
  }
  return files;
}
/**
 * Writes an FFmpeg filter script. FFmpeg 4.x rejects a trailing ";" ("No such filter: ''"); newer builds ignore it,
 * so every script is written without one.
 */
const writeGraph = (file, text) => fs.writeFile(file, `${String(text).replace(/;\s*$/, '')}\n`, 'utf8');
/** All sound effects of an edit mixed into one track (one input for the main render). */
export async function buildSfxTrack(sfx, total, tmpRoot, tools) {
  const list = sfx.filter(x => x.time < total - 0.05).slice(0, 300);
  const kinds = [...new Set(list.map(x => x.kind))], files = await ensureSfxLibrary(kinds, tools);
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-y'];
  kinds.forEach(k => args.push('-i', files[k]));
  const lines = [], outs = [];
  kinds.forEach((k, ki) => {
    const rows = list.filter(x => x.kind === k);
    if (!rows.length) return;
    const labels = rows.map((_, j) => `k${ki}_${j}`);
    lines.push(rows.length === 1 ? `[${ki}:a]anull[${labels[0]}]` : `[${ki}:a]asplit=${rows.length}${labels.map(l => `[${l}]`).join('')}`);
    rows.forEach((x, j) => { lines.push(`[${labels[j]}]volume=${Number(x.gain).toFixed(3)},adelay=${Math.round(x.time * 1000)}:all=1[o${outs.length}]`); outs.push(`[o${outs.length}]`); });
  });
  // Pad and cut by SAMPLE COUNT on rebuilt timestamps: with an effect used twice (asplit) the mixed stream's
  // timestamps never reach a time-based atrim, and "apad,atrim=duration" then wrote silence until the disk was full.
  const samples = Math.max(1, Math.round(total * 48000));
  if (!outs.length) lines.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${total.toFixed(3)}[mix]`);
  else lines.push(`${outs.join('')}${outs.length > 1 ? `amix=inputs=${outs.length}:duration=longest:dropout_transition=0:normalize=0,` : 'anull,'}aresample=48000,asetpts=N/SR/TB,apad=whole_len=${samples},atrim=end_sample=${samples}[mix]`);
  const script = path.join(tmpRoot, 'sfx-filter.txt'), out = path.join(tmpRoot, 'sfx-track.wav');
  await writeGraph(script, lines.join(';\n'));
  // -t is a second guard: the track can never outgrow the edit.
  await runProcess(tools.ffmpeg, [...args, ...filterComplexFile(script, tools.ffmpeg), '-map', '[mix]', '-t', total.toFixed(3), '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', out], { timeoutMs: 10 * 60_000 });
  return out;
}

export async function renderTrailer(plan, {
  jobRoot,
  output,
  resolution = '2560x1440',
  fps = 60,
  preview = false,
  title = '',
  music = '',
  label = '', endTitle = '', logo = '', gameGain = 1, musicGain = 0.24,
  vertical = false, maxBytes = 0, software = false, cinematic = false,
  look = 'neutral', lookStrength = 0.7, exposure = 0, fadeIn = 0.2, fadeOut = 0.65,
  duckMusic = false, reduceRumble = false,
  sourceChannel = 'stereo', narration = '', narrationStart = 0, narrationTrimStart = 0, narrationGain = 1,
  captions = [], captionOffset = 0, captionStyle = 'box', captionPosition = 'low', musicTrimStart = 0, texts = [],
  fontFile: brandFont = '', colors = {}, logoPosition = 'top-left', logoScale = 0.13, logoOpacity = 1, intro = '', outro = '',
  captionAnimation = 'none', captionCase = 'normal', voiceEnhance = 'off', loudnessTarget = null, overlayClips = [],
  segmented = 'auto', cacheDir = null, segmentOptions = {},
  lut = '', lutStrength = 1, progressBar = 'off', sfx = [], audioRepair = null,
  tools = findFfmpegTools(),
  onProgress,
} = {}) {
  if (!plan?.clips?.length) throw new StudioError('EMPTY_PLAN', 'The trailer plan contains no clips.');
  if (!Number.isFinite(plan.actualDuration) || plan.actualDuration <= 0
    || !Number.isFinite(gameGain) || gameGain < 0 || gameGain > 2
    || !Number.isFinite(musicGain) || musicGain < 0 || musicGain > 1) {
    throw new StudioError('INVALID_PLAN', 'Duration or audio mix is invalid.');
  }
  const finish = normalizeFinish({ look, lookStrength, exposure, fadeIn, fadeOut, duckMusic, reduceRumble, sourceChannel });
  if (![narrationStart, narrationTrimStart, narrationGain].every(Number.isFinite) || narrationStart < 0 || narrationTrimStart < 0 || narrationTrimStart > 7200 || narrationGain < 0 || narrationGain > 2
    || (narration && narrationStart >= plan.actualDuration)) throw new StudioError('INVALID_AUDIO', 'Invalid voice-over volume, source trim or start point on the timeline.');
  if (!Number.isFinite(captionOffset) || Math.abs(captionOffset) > 30) throw new StudioError('INVALID_CAPTIONS', 'Caption offset must be between -30 and 30 seconds.');
  const mappedCaptions = mapCaptions(normalizeCaptions(captions), plan.clips, captionOffset);
  // Also guard callers of the standalone renderer, which may bypass Studio validation.
  for (const clip of plan.clips) {
    normalizeTransform(clip); normalizeTransition(clip);
    const speed = clip.speed ?? 1, gain = clip.gain ?? 1;
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 2 || !Number.isFinite(gain) || gain < 0 || gain > 2
      || !Number.isFinite(clip.start) || !Number.isFinite(clip.end) || clip.start < 0 || clip.end <= clip.start
      || !Number.isFinite(clip.duration) || clip.duration <= 0
      || Math.abs((clip.end - clip.start) / speed - clip.duration) > 0.01) {
      throw new StudioError('INVALID_CLIP', 'Clip duration, speed or volume is invalid.');
    }
  }
  if (Math.abs(plan.clips.reduce((sum, c, i) => sum + c.duration - (i ? overlapOf(plan.clips[i - 1], c) : 0), 0) - plan.actualDuration) > 0.02) {
    throw new StudioError('INVALID_PLAN', 'Edit duration does not match the clips.');
  }
  await ensureDataRoot(2 * 1024 ** 3);
  const safeJobRoot = safeResolveWithin(DATA_ROOT, path.relative(DATA_ROOT, path.resolve(jobRoot)));
  const defaultName = preview ? 'preview.mp4' : 'trailer.mp4';
  const finalOutput = output
    ? safeResolveWithin(DATA_ROOT, path.relative(DATA_ROOT, path.resolve(output)))
    : safeResolveWithin(safeJobRoot, 'output', defaultName);
  if (path.extname(finalOutput).toLowerCase() !== '.mp4') {
    throw new StudioError('INVALID_OUTPUT_FORMAT', 'Trailer output must be an .mp4 file.');
  }
  await fs.mkdir(path.dirname(finalOutput), { recursive: true });
  if (fsSync.existsSync(finalOutput)) {
    throw new StudioError('OUTPUT_EXISTS', `Output already exists; nothing was overwritten: ${finalOutput}`);
  }

  const { width, height } = parseResolution(resolution, preview);
  const outputFps = preview ? 30 : Math.max(24, Math.min(120, Number(fps) || 60));
  const ffmpegInfo = await inspectFfmpeg({ smokeTest: !software, tools });
  if (software) ffmpegInfo.capabilities.nvencReady = false;
  const warnings = [];
  if (software) warnings.push('Software encoding was explicitly chosen for this run; the GPU was not tested or used.');
  else if (!ffmpegInfo.capabilities.nvencReady) warnings.push(`NVENC not available; software encoder used. ${ffmpegInfo.nvencError ?? ''}`.trim());
  const caps = ffmpegInfo.capabilities;
  let lutFile = null;
  if (lut) {
    if (!fsSync.existsSync(lut)) throw new StudioError('LUT_NOT_FOUND', `LUT file not found: ${lut}`);
    if (caps.lut3d === false) warnings.push('This FFmpeg build has no lut3d filter; the LUT was skipped.');
    else lutFile = path.resolve(lut);
  }
  if (plan.clips.some(c => c.stabilize > 0 && c.stabFile) && caps.vidstab === false) {
    warnings.push('This FFmpeg build has no vid.stab; stabilised shots use the simpler deshake filter.');
    plan = { ...plan, clips: plan.clips.map(({ stabFile, ...c }) => c) };
  }
  const legacyTemperature = caps.colortemperature === false;

  const tmpRoot = safeResolveWithin(safeJobRoot, 'tmp');
  await fs.mkdir(tmpRoot, { recursive: true });
  const titleFile = safeResolveWithin(tmpRoot, 'title.txt');
  const cleanedTitle = String(title || plan.title || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 140);
  await fs.writeFile(titleFile, cleanedTitle, 'utf8');
  const labelFile = safeResolveWithin(tmpRoot, 'label.txt');
  const endTitleFile = safeResolveWithin(tmpRoot, 'end-title.txt');
  await fs.writeFile(labelFile, String(label).replace(/[\r\n\t\0]/g, ' ').slice(0, 70), 'utf8');
  await fs.writeFile(endTitleFile, String(endTitle).replace(/[\r\n\t\0]/g, ' ').slice(0, 100), 'utf8');
  const filterFile = safeResolveWithin(tmpRoot, preview ? 'preview-filter.txt' : 'render-filter.txt');
  const captionFiles = [];
  for (const [index, cue] of mappedCaptions.entries()) {
    const file = safeResolveWithin(tmpRoot, `caption-${index}.txt`);
    const words = cue.text.split(' '), lines = []; let line = '';
    const max = captionStyle === 'bold' ? (vertical ? 16 : 30) : vertical ? 24 : 44;
    for (const word of words.flatMap(w => w.match(new RegExp(`.{1,${max}}`, 'gu')) || [])) {
      if (line && (line + ' ' + word).length > max) { lines.push(line); line = ''; }
      line += (line ? ' ' : '') + word;
    }
    if (line) lines.push(line);
    await fs.writeFile(file, lines.join('\n'), 'utf8'); captionFiles.push({ ...cue, file });
  }
  const textFiles = [];
  let normalizedTexts;
  try { normalizedTexts = normalizeTexts(texts); } catch (e) { throw new StudioError('INVALID_TEXT', e.message); }
  for (const [index, item] of normalizedTexts.entries()) {
    if (item.start >= plan.actualDuration - 0.05) continue;
    const file = safeResolveWithin(tmpRoot, `text-${index}.txt`);
    const max = { big: vertical ? 12 : 18, title: vertical ? 18 : 30, lower: vertical ? 22 : 40, note: vertical ? 22 : 40, callout: vertical ? 16 : 28 }[item.style] ?? 30;
    const lines = []; let line = '';
    for (const word of item.text.split(' ').flatMap(w => w.match(new RegExp(`.{1,${max}}`, 'gu')) || [])) {
      if (line && (line + ' ' + word).length > max) { lines.push(line); line = ''; }
      line += (line ? ' ' : '') + word;
    }
    if (line) lines.push(line);
    await fs.writeFile(file, lines.join('\n'), 'utf8');
    textFiles.push({ ...item, end: Math.min(item.end, plan.actualDuration), file });
  }
  // Animated (word-by-word) captions go through libass; static ones keep the drawtext path.
  let assFile = null, fontsDir = null, writeAss = null;
  if (mappedCaptions.length && captionAnimation && captionAnimation !== 'none') {
    if (!ffmpegInfo.capabilities.ass) warnings.push('Animated captions need an FFmpeg build with libass; static captions were used.');
    else {
      assFile = safeResolveWithin(tmpRoot, 'captions.ass');
      const family = brandFont && fsSync.existsSync(brandFont) ? fontFamily(brandFont) : null;
      if (family) fontsDir = path.dirname(path.resolve(brandFont));
      writeAss = (file, cues) => fs.writeFile(file, buildAss(cues, { width, height, animation: captionAnimation, style: captionStyle, position: captionPosition, colors,
        fontName: family ?? (process.platform === 'win32' ? 'Segoe UI Black' : 'DejaVu Sans'), upper: captionCase === 'upper' }), 'utf8');
      await writeAss(assFile, mappedCaptions);
    }
  }
  if (((captionFiles.length && !assFile) || textFiles.length) && !ffmpegInfo.capabilities.drawtext) throw new StudioError('CAPTIONS_UNAVAILABLE', `This FFmpeg build does not support on-screen text (drawtext). ${ffmpegInstallHint()}`);
  const fontFile = brandFont && fsSync.existsSync(brandFont) ? path.resolve(brandFont)
    : process.platform === 'win32' && fsSync.existsSync('C:\\Windows\\Fonts\\segoeuib.ttf') ? 'C:\\Windows\\Fonts\\segoeuib.ttf' : null;

  const args = ['-hide_banner', '-nostdin', '-n'];
  const total = plan.actualDuration;
  // Long edits: render cached, fully finished picture segments (bounded memory; a fix re-renders only its
  // segment), then one fast pass that copies the picture and mixes the sound of the whole programme.
  const programStarts = []; { let t = 0; plan.clips.forEach((c, i) => { t -= i ? overlapOf(plan.clips[i - 1], c) : 0; programStarts.push(t); t += c.duration; }); }
  const titleEnd = cleanedTitle ? (cinematic ? 4.5 : 3) : 0;
  const overlaySpan = o => [o.at, o.at + Math.min(o.end - o.start, total - o.at)];
  // Segment cuts never fall inside a caption, text, layer, the title, the fade-in or the last 6 s (end title, fade-out).
  const blocked = [...mappedCaptions.map(c => [c.start, c.end]), ...textFiles.map(t => [t.start, t.end]), ...overlayClips.map(overlaySpan),
    [0, Math.max(titleEnd, finish.fadeIn)], [total - Math.max(6, finish.fadeOut + 0.5), total]];
  const segments = segmented === false || segmented === 'off' ? null : (() => {
    const auto = plan.clips.length >= 60 || total >= 180;
    if (!(segmented === true || segmented === 'on' || auto)) return null;
    const b = segmentBoundaries(plan.clips, { ...segmentOptions, blocked });
    return b.length >= 2 ? b : null;
  })();
  const filterOption = file => (ffmpegInfo.capabilities.fileOptions === false ? ['-filter_complex_script', file] : ['-/filter_complex', file]);
  const filterBase = { width, height, fps: outputFps, fontFile, drawtext: ffmpegInfo.capabilities.drawtext, labelFile, label, vertical, cinematic, colors, logoPosition, logoScale, logoOpacity, fontsDir,
    lutFile, lutStrength, progressBar, programDuration: total, legacyTemperature,
    captionStyle: ['box', 'bold', 'minimal'].includes(captionStyle) ? captionStyle : 'box', captionPosition: ['low', 'middle', 'high'].includes(captionPosition) ? captionPosition : 'low' };
  let videoInputs = [], audioInputs = [], segmentReport = null, segmentIntro = null, segmentOutro = null;
  if (segments) {
    const cache = cacheDir ? safeResolveWithin(DATA_ROOT, path.relative(DATA_ROOT, path.resolve(cacheDir))) : safeResolveWithin(safeJobRoot, 'segments');
    await fs.mkdir(cache, { recursive: true });
    const stamp = async file => { const st = await fs.stat(file).catch(() => null); return st ? `${st.size}:${Math.round(st.mtimeMs)}` : 'missing'; };
    const contentHash = file => createHash('sha1').update(fsSync.readFileSync(file)).digest('hex').slice(0, 16);
    const videoArgs = [...encoderArguments(ffmpegInfo.capabilities, preview, maxBytes, total), '-pix_fmt', 'yuv420p'];
    // The key is what FFmpeg is asked to do (temporary text files replaced by their content), so it is the
    // same whenever the segment's pixels and sound would be the same — wherever it sits on the timeline.
    const keyOf = async (segArgs, filterText, tmpFiles) => {
      let text = filterText;
      for (const f of tmpFiles) text = text.replaceAll(filterPath(f), `#${contentHash(f)}`);
      const stamps = []; for (let i = 0; i < segArgs.length; i++) if (segArgs[i] === '-i') stamps.push(await stamp(segArgs[i + 1]));
      return createHash('sha1').update(JSON.stringify([SEGMENT_VERSION, text, segArgs, stamps, videoArgs, outputFps])).digest('hex').slice(0, 24);
    };
    let reused = 0, rendered = 0, doneSeconds = 0;
    const work = total + (intro ? 30 : 0) + (outro ? 30 : 0);
    const encodeSegment = async (key, run, what) => {
      const video = path.join(cache, `${key}.ts`), audio = path.join(cache, `${key}.wav`);
      if (fsSync.existsSync(video) && fsSync.existsSync(audio)) {
        reused++; const now = new Date();
        await fs.utimes(video, now, now).catch(() => {}); await fs.utimes(audio, now, now).catch(() => {});
        return { video, audio };
      }
      const vp = path.join(cache, `.${randomUUID()}.partial.ts`), ap = path.join(cache, `.${randomUUID()}.partial.wav`);
      try { await run(vp, ap); await fs.rename(vp, video); await fs.rename(ap, audio); }
      catch (error) {
        await fs.rm(vp, { force: true }).catch(() => {}); await fs.rm(ap, { force: true }).catch(() => {});
        throw error instanceof StudioError ? error : new StudioError('RENDER_FAILED', `${what} failed: ${error.message}`, { cause: error });
      }
      rendered++; return { video, audio };
    };
    const segmentRun = (inputArgs, filterArgs, seconds) => (vp, ap) => runProcess(tools.ffmpeg, [...inputArgs, '-progress', 'pipe:1', '-nostats', ...filterArgs,
      '-map', '[vout]', ...videoArgs, '-threads', '4', '-f', 'mpegts', vp, '-map', '[aout]', '-c:a', 'pcm_s16le', '-ar', '48000', '-f', 'wav', ap], {
      timeoutMs: 3 * 60 * 60_000, maxOutputBytes: 32 * 1024 * 1024,
      onLine(line) { const m = String(line).match(/^out_time_(?:ms|us)=(\d+)/); if (m) onProgress?.({ phase: 'segments', progress: Math.min(0.92, 0.92 * (doneSeconds + Math.min(seconds, Number(m[1]) / 1e6)) / work) }); },
    });
    const parts = [];
    for (const [k, indices] of segments.entries()) {
      const clips = indices.map(i => plan.clips[i]);
      const t0 = programStarts[indices[0]];
      const D = clips.reduce((sum, c, i) => sum + c.duration - (i ? overlapOf(clips[i - 1], c) : 0), 0);
      const first = k === 0, last = k === segments.length - 1;
      const inside = a => a >= t0 - 1e-3 && a < t0 + D - 1e-3;
      const segArgs = ['-hide_banner', '-nostdin', '-y'];
      const inputs = pushClipInputs(segArgs, clips, outputFps);
      const count = () => segArgs.filter(x => x === '-i').length;
      let logoIndex = null;
      if (logo) { logoIndex = count(); segArgs.push('-protocol_whitelist', 'file,pipe', '-loop', '1', '-framerate', String(outputFps), '-t', D.toFixed(3), '-i', path.resolve(logo)); }
      const segOverlays = [], segOverlayInputs = [];
      for (const o of overlayClips) {
        if (!o.file || !fsSync.existsSync(o.file) || o.at >= total - 0.05 || !inside(o.at)) { segOverlays.push(o); segOverlayInputs.push(null); continue; }
        const d = Math.min(o.end - o.start, total - o.at);
        segOverlayInputs.push(count());
        if (/\.(png|jpe?g|webp)$/i.test(o.file)) segArgs.push('-protocol_whitelist', 'file,pipe', '-loop', '1', '-framerate', String(outputFps), '-t', d.toFixed(3), '-i', o.file);
        else segArgs.push('-protocol_whitelist', 'file,pipe', '-threads', '2', '-ss', o.start.toFixed(3), '-t', d.toFixed(3), '-i', o.file);
        segOverlays.push({ ...o, at: o.at - t0 });
      }
      const rebase = c => ({ ...c, start: Math.max(0, c.start - t0), end: c.end - t0, ...(c.words ? { words: c.words.map(w => ({ ...w, start: Math.max(0, w.start - t0), end: w.end - t0 })) } : {}) });
      const segCaptions = assFile ? [] : captionFiles.filter(c => inside(c.start)).map(rebase);
      let segAss = null;
      if (assFile) {
        const cues = mappedCaptions.filter(c => inside(c.start)).map(rebase);
        if (cues.length) { segAss = safeResolveWithin(tmpRoot, `captions-${k}.ass`); await writeAss(segAss, cues); }
      }
      const segTexts = textFiles.filter(t => inside(t.start)).map(t => ({ ...t, start: t.start - t0, end: t.end - t0 }));
      const filterText = buildFilter({ ...plan, clips, actualDuration: D }, { ...filterBase,
        title: first ? cleanedTitle : '', titleFile, endTitle: last ? endTitle : '', endTitleFile,
        finish: { ...finish, fadeIn: first ? finish.fadeIn : 0, fadeOut: last ? finish.fadeOut : 0 },
        captionFiles: segCaptions, assFile: segAss, textFiles: segTexts, logoInputIndex: logoIndex,
        overlays: segOverlays, overlayInputs: segOverlayInputs, overlayAudioInputs: segOverlayInputs.map(() => null), stage: 'segment', timeOffset: t0, ...inputs });
      const filterFile = safeResolveWithin(tmpRoot, `segment-${k}-filter.txt`);
      await writeGraph(filterFile, filterText);
      const key = await keyOf(segArgs, filterText, [titleFile, labelFile, endTitleFile, ...segCaptions.map(c => c.file), ...segTexts.map(t => t.file), segAss].filter(Boolean));
      parts.push({ ...(await encodeSegment(key, segmentRun(segArgs, ['-filter_complex_threads', '2', ...filterOption(filterFile)], D), `Segment ${k + 1}/${segments.length}`)), duration: D });
      doneSeconds += D;
      onProgress?.({ phase: 'segments', progress: 0.92 * doneSeconds / work, segment: k + 1, segments: segments.length });
    }
    // Brand intro/outro become segments too: scaled to the frame once, cached, joined without re-encoding.
    for (const [role, file] of [['intro', intro], ['outro', outro]]) {
      if (!file) continue;
      if (!fsSync.existsSync(file)) throw new StudioError('BRAND_MEDIA_MISSING', `Brand intro/outro not found: ${file}`);
      const info = await probeMedia(file, tools);
      if (info.duration > 30) throw new StudioError('BRAND_MEDIA_TOO_LONG', 'Brand intro/outro may be at most 30 seconds.');
      const n = Math.max(1, Math.round(info.duration * outputFps)), d = n / outputFps;
      const graph = `[0:v:0]fps=${outputFps},scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,setpts=PTS-STARTPTS,tpad=stop=-1:stop_mode=clone,trim=end_frame=${n}[vout];`
        + (info.audio ? `[0:a:0]aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS,apad,atrim=duration=${d.toFixed(6)}[aout]` : `anullsrc=r=48000:cl=stereo,atrim=duration=${d.toFixed(6)}[aout]`);
      const inputArgs = ['-hide_banner', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-i', path.resolve(file)];
      const key = createHash('sha1').update(JSON.stringify([SEGMENT_VERSION, 'brand', graph, path.resolve(file), await stamp(file), videoArgs, outputFps])).digest('hex').slice(0, 24);
      const part = { ...(await encodeSegment(key, segmentRun(inputArgs, ['-filter_complex', graph], d), `Brand ${role}`)), duration: d };
      if (role === 'intro') segmentIntro = part; else segmentOutro = part;
      doneSeconds += 30;
    }
    const quote = f => `file '${f.replaceAll("'", "'\\''")}'`;
    const videoList = path.join(tmpRoot, 'segments-video.txt'), audioList = path.join(tmpRoot, 'segments-audio.txt');
    await fs.writeFile(videoList, [segmentIntro, ...parts, segmentOutro].filter(Boolean).map(x => `${quote(x.video)}\nduration ${x.duration.toFixed(6)}`).join('\n') + '\n', 'utf8');
    await fs.writeFile(audioList, parts.map(x => quote(x.audio)).join('\n') + '\n', 'utf8');
    args.push('-protocol_whitelist', 'file,pipe', '-f', 'concat', '-safe', '0', '-i', videoList, '-protocol_whitelist', 'file,pipe', '-f', 'concat', '-safe', '0', '-i', audioList);
    for (const part of [segmentIntro, segmentOutro]) if (part) { part.input = args.filter(x => x === '-i').length; args.push('-i', part.audio); }
    segmentReport = { count: segments.length, reused, rendered, cache };
    // Bounded cache: keep the 400 most recently used segment files.
    try {
      const all = await Promise.all((await fs.readdir(cache)).filter(n => /\.(ts|wav)$/.test(n) && !n.startsWith('.')).map(async n => ({ n, t: (await fs.stat(path.join(cache, n))).mtimeMs })));
      for (const old of all.sort((a, b) => b.t - a.t).slice(400)) await fs.rm(path.join(cache, old.n), { force: true });
    } catch { /* cache cleanup is best effort */ }
  } else {
    ({ videoInputs, audioInputs } = pushClipInputs(args, plan.clips, outputFps));
  }
  const inputCount = () => args.filter(x => x === '-i').length;
  let musicInputIndex = null;
  if (music) {
    const musicPath = path.resolve(music);
    if (!fsSync.existsSync(musicPath)) throw new StudioError('MUSIC_NOT_FOUND', `Music file not found: ${musicPath}`);
    musicInputIndex = inputCount();
    const skip = Number.isFinite(Number(musicTrimStart)) ? Math.max(0, Math.min(600, Number(musicTrimStart))) : 0;
    args.push('-protocol_whitelist', 'file,pipe', '-stream_loop', '-1', ...(skip > 0 ? ['-ss', skip.toFixed(3)] : []), '-t', plan.actualDuration.toFixed(3), '-i', musicPath);
  }

  let sfxInputIndex = null;
  if (sfx?.length) {
    const track = await buildSfxTrack(sfx, plan.actualDuration, tmpRoot, tools);
    sfxInputIndex = inputCount();
    args.push('-protocol_whitelist', 'file,pipe', '-i', track);
  }
  let narrationInputIndex = null;
  if (narration) {
    narrationInputIndex = inputCount();
    args.push('-protocol_whitelist', 'file,pipe', '-ss', narrationTrimStart.toFixed(3), '-t', (plan.actualDuration - narrationStart).toFixed(3), '-i', path.resolve(narration));
  }
  let logoInputIndex = null;
  if (logo && !segments) {
    logoInputIndex = inputCount();
    args.push('-protocol_whitelist', 'file,pipe', '-loop', '1', '-framerate', String(outputFps), '-t', plan.actualDuration.toFixed(3), '-i', path.resolve(logo));
  }
  // Overlay layers (B-roll / picture-in-picture): own video input, optional own audio input.
  const overlayInputs = [], overlayAudioInputs = [];
  for (const o of overlayClips) {
    if (!o.file || !fsSync.existsSync(o.file) || o.at >= plan.actualDuration - 0.05) { overlayInputs.push(null); overlayAudioInputs.push(null); continue; }
    const d = Math.min(o.end - o.start, plan.actualDuration - o.at), still = /\.(png|jpe?g|webp)$/i.test(o.file);
    if (segments) overlayInputs.push(null); // picture already in the segments; only the layer's sound is mixed here
    else overlayInputs.push(inputCount());
    if (segments) { /* no video input */ } else if (still) args.push('-protocol_whitelist', 'file,pipe', '-loop', '1', '-framerate', String(outputFps), '-t', d.toFixed(3), '-i', o.file);
    else args.push('-protocol_whitelist', 'file,pipe', '-threads', '2', '-ss', o.start.toFixed(3), '-t', d.toFixed(3), '-i', o.file);
    if (o.gain > 0 && o.hasAudio && !still) { overlayAudioInputs.push(inputCount()); args.push('-protocol_whitelist', 'file,pipe', '-vn', '-ss', o.start.toFixed(3), '-t', d.toFixed(3), '-i', o.file); }
    else overlayAudioInputs.push(null);
  }
  const filter = buildFilter(plan, {
    width, height, fps: outputFps, title: cleanedTitle, titleFile, fontFile,
    musicInputIndex, drawtext: ffmpegInfo.capabilities.drawtext,
    labelFile, label, endTitleFile, endTitle, logoInputIndex,
    gameGain: Math.max(0, Math.min(2, Number(gameGain))), musicGain: Math.max(0, Math.min(1, Number(musicGain))), vertical, cinematic,
    finish,
    captionFiles,
    narrationInputIndex, narrationStart, narrationGain,
    textFiles, videoInputs, audioInputs, colors, logoPosition, logoScale, logoOpacity, assFile, fontsDir,
    voiceEnhance: ['off', 'light', 'strong'].includes(voiceEnhance) ? voiceEnhance : 'off', loudnessTarget: Number.isFinite(Number(loudnessTarget)) && loudnessTarget !== null ? Math.max(-24, Math.min(-9, Number(loudnessTarget))) : null,
    overlays: overlayClips, overlayInputs, overlayAudioInputs, stage: segments ? 'audio' : 'full', programAudioInput: 1,
    lutFile, lutStrength, progressBar, programDuration: plan.actualDuration, legacyTemperature, sfxInputIndex, audioRepair,
    captionStyle: ['box', 'bold', 'minimal'].includes(captionStyle) ? captionStyle : 'box',
    captionPosition: ['low', 'middle', 'high'].includes(captionPosition) ? captionPosition : 'low',
  });
  // Segmented: brand intro/outro sound goes around the mixed programme sound (their picture is in the video list).
  const brandAudio = segments && (segmentIntro || segmentOutro)
    ? `;\n${[segmentIntro, segmentOutro].filter(Boolean).map(x => `[${x.input}:a:0]aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,asetpts=N/SR/TB[b${x.input}]`).join(';\n')};\n${[segmentIntro && `[b${segmentIntro.input}]`, '[aprog]', segmentOutro && `[b${segmentOutro.input}]`].filter(Boolean).join('')}concat=n=${1 + Boolean(segmentIntro) + Boolean(segmentOutro)}:v=0:a=1[aout];\n`
    : null;
  await writeGraph(filterFile, brandAudio ? filter.replace('[aout]', '[aprog]').replace(/;\n$/, '') + brandAudio : filter, 'utf8');
  const outputSeconds = (segmentIntro?.duration ?? 0) + plan.actualDuration + (segmentOutro?.duration ?? 0);
  if (cleanedTitle && !ffmpegInfo.capabilities.drawtext) warnings.push('Title overlay skipped: this FFmpeg build has no drawtext filter.');

  const partial = outputPartialPath(finalOutput);
  safeResolveWithin(DATA_ROOT, path.relative(DATA_ROOT, partial));
  args.push(
    '-filter_complex_threads', '2', ...(ffmpegInfo.capabilities.fileOptions === false ? ['-filter_complex_script', filterFile] : ['-/filter_complex', filterFile]),
    ...(segments ? ['-map', '0:v:0', '-c:v', 'copy', '-video_track_timescale', '90000', '-map', '[aout]']
      : ['-map', '[vout]', '-map', '[aout]', ...encoderArguments(ffmpegInfo.capabilities, preview, maxBytes, plan.actualDuration), '-threads', '4', '-pix_fmt', 'yuv420p']),
    '-c:a', 'aac', '-b:a', maxBytes ? '128k' : preview ? '192k' : '256k',
    '-ar', '48000', '-movflags', '+faststart',
    '-t', outputSeconds.toFixed(3), '-progress', 'pipe:1', '-nostats', partial,
  );

  let lastProgress = 0;
  try {
    await runProcess(tools.ffmpeg, args, {
      timeoutMs: 6 * 60 * 60_000,
      maxOutputBytes: 32 * 1024 * 1024,
      onLine(line) {
        const match = String(line).match(/^out_time_(?:ms|us)=(\d+)/);
        if (!match) return;
        const seconds = Number(match[1]) / 1_000_000;
        const progress = Math.min(0.98, (segments ? 0.92 : 0) + (segments ? 0.06 : 1) * seconds / Math.max(0.1, outputSeconds));
        if (progress - lastProgress >= 0.01) {
          lastProgress = progress;
          onProgress?.({ phase: 'render', progress, seconds, output: finalOutput });
        }
      },
    });
  } catch (error) {
    await fs.rm(partial, { force: true });
    throw new StudioError('RENDER_FAILED', `Trailer render failed: ${error.message}`, { cause: error });
  }

  let introSeconds = segmentIntro?.duration ?? 0;
  if ((intro || outro) && !segments) {
    // Brand intro/outro: wrap the programme, scaled and padded to the same frame, in one extra pass.
    onProgress?.({ phase: 'brand', progress: 0.985, output: finalOutput });
    const wrapped = outputPartialPath(finalOutput);
    try {
      const parts = [];
      for (const file of [intro, outro]) if (file) {
        if (!fsSync.existsSync(file)) throw new StudioError('BRAND_MEDIA_MISSING', `Brand intro/outro not found: ${file}`);
        const info = await probeMedia(file, tools);
        if (info.duration > 30) throw new StudioError('BRAND_MEDIA_TOO_LONG', 'Brand intro/outro may be at most 30 seconds.');
        parts.push({ file, duration: info.duration, hasAudio: Boolean(info.audio), role: file === intro ? 'intro' : 'outro' });
      }
      const order = [parts.find(p => p.role === 'intro'), { file: partial, hasAudio: true, duration: plan.actualDuration }, parts.find(p => p.role === 'outro')].filter(Boolean);
      introSeconds = order[0].file === partial ? 0 : order[0].duration;
      const wrapArgs = ['-hide_banner', '-nostdin', '-n'];
      order.forEach(p => wrapArgs.push('-protocol_whitelist', 'file,pipe', '-i', p.file));
      const chains = order.map((p, i) => `[${i}:v:0]fps=${outputFps},scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[w${i}];`
        + (p.hasAudio ? `[${i}:a:0]aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[x${i}]` : `anullsrc=r=48000:cl=stereo,atrim=duration=${p.duration.toFixed(3)}[x${i}]`));
      const graph = `${chains.join(';')};${order.map((_, i) => `[w${i}][x${i}]`).join('')}concat=n=${order.length}:v=1:a=1[vw][aw]`;
      await runProcess(tools.ffmpeg, [...wrapArgs, '-filter_complex', graph, '-map', '[vw]', '-map', '[aw]',
        ...encoderArguments(ffmpegInfo.capabilities, preview, maxBytes, order.reduce((t, p) => t + p.duration, 0)),
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', maxBytes ? '128k' : '256k', '-ar', '48000', '-movflags', '+faststart', wrapped], { timeoutMs: 2 * 60 * 60_000 });
      await fs.rm(partial, { force: true });
      await fs.rename(wrapped, partial);
    } catch (error) {
      await fs.rm(wrapped, { force: true }).catch(() => {});
      await fs.rm(partial, { force: true }).catch(() => {});
      throw error instanceof StudioError ? error : new StudioError('RENDER_FAILED', `Brand intro/outro failed: ${error.message}`, { cause: error });
    }
  }

  onProgress?.({ phase: 'verify', progress: 0.99, output: finalOutput });
  let verified;
  try {
    verified = await verifyVideo(partial, tools);
    // A hard link publishes atomically on the same volume and, unlike rename,
    // fails with EEXIST instead of replacing a file created by another job.
    await fs.link(partial, finalOutput);
    await fs.rm(partial);
  } catch (error) {
    await fs.rm(partial, { force: true }).catch(() => {});
    if (error?.code === 'EEXIST') {
      throw new StudioError('OUTPUT_EXISTS', `Output already exists; nothing was overwritten: ${finalOutput}`, { cause: error });
    }
    throw error;
  }
  const result = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    output: finalOutput,
    preview,
    duration: verified.duration,
    width: verified.video.width,
    height: verified.video.height,
    fps: verified.video.fps,
    encoder: ffmpegInfo.capabilities.nvencReady ? 'h264_nvenc' : 'libx264',
    audioMix: 'normalised-before-gain-v3',
    finishing: finish,
    captionCount: mappedCaptions.length, textCount: textFiles.length, introSeconds, segments: segmentReport ? { count: segmentReport.count, reused: segmentReport.reused, rendered: segmentReport.rendered } : null, captionAnimation: assFile ? captionAnimation : 'none',
    brand: intro || outro || brandFont || Object.keys(colors).length ? { intro: intro || null, outro: outro || null, font: fontFile, colors } : undefined,
    narration: narration ? { file: path.resolve(narration), start: narrationStart, trimStart: narrationTrimStart, gain: narrationGain } : null,
    warnings,
  };
  if (mappedCaptions.length) {
    result.subtitles = finalOutput.replace(/\.mp4$/i, '.srt');
    await fs.writeFile(result.subtitles, toSrt(mappedCaptions.map(c => ({ ...c, start: c.start + introSeconds, end: c.end + introSeconds }))), { encoding: 'utf8', flag: 'wx' });
  }
  await writeJsonAtomic(safeResolveWithin(safeJobRoot, preview ? 'preview-result.json' : 'render-result.json'), result);
  onProgress?.({ phase: 'complete', progress: 1, output: finalOutput });
  return result;
}

/**
 * Audio stems for mixing elsewhere (WAV 48 kHz / 24-bit): programme sound ("dialogue": the shots' own sound,
 * repaired and levelled like in the mix), voice-over, music, sound effects, and the final mix. Stems are taken
 * before the master loudness and limiter, so they add up to the mix before mastering.
 */
export async function renderStems(plan, {
  jobRoot, music = '', musicGain = 0.24, musicTrimStart = 0, narration = '', narrationStart = 0, narrationTrimStart = 0, narrationGain = 1,
  gameGain = 1, sfx = [], audioRepair = null, voiceEnhance = 'off', loudnessTarget = -14, overlayClips = [], tools = findFfmpegTools(), onProgress,
  look, lookStrength, exposure, fadeIn = 0.2, fadeOut = 0.65, duckMusic = false, reduceRumble = false, sourceChannel = 'stereo',
} = {}) {
  if (!plan?.clips?.length) throw new StudioError('EMPTY_PLAN', 'The edit contains no clips.');
  const root = safeResolveWithin(DATA_ROOT, path.relative(DATA_ROOT, path.resolve(jobRoot)));
  const tmpRoot = path.join(root, 'tmp'), outDir = path.join(root, 'stems');
  await fs.mkdir(tmpRoot, { recursive: true }); await fs.mkdir(outDir, { recursive: true });
  const finish = normalizeFinish({ look, lookStrength, exposure, fadeIn, fadeOut, duckMusic, reduceRumble, sourceChannel });
  const total = plan.actualDuration;
  // 1. The shots' sound, joined exactly as in the picture edit (no video decoded).
  const programme = path.join(tmpRoot, 'programme.wav');
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-y'], audioInputs = [], windows = audioWindows(plan.clips);
  plan.clips.forEach((clip, i) => {
    if (!clip.hasAudio || /\.(png|jpe?g|webp)$/i.test(clip.source)) { audioInputs.push(0); return; }
    audioInputs.push(args.filter(x => x === '-i').length);
    args.push('-protocol_whitelist', 'file,pipe', '-vn', '-ss', Math.max(0, windows[i].aStart).toFixed(3), '-t', (windows[i].aEnd - Math.max(0, windows[i].aStart)).toFixed(3), '-i', clip.source);
  });
  if (!args.includes('-i')) args.push('-f', 'lavfi', '-t', '0.1', '-i', 'anullsrc=r=48000:cl=stereo');
  const graph1 = path.join(tmpRoot, 'programme-filter.txt');
  await writeGraph(graph1, buildFilter({ ...plan, clips: plan.clips.map(c => ({ ...c, hasAudio: c.hasAudio && !/\.(png|jpe?g|webp)$/i.test(c.source) })) }, { width: 320, height: 180, fps: 30, stage: 'clipaudio', audioInputs, videoInputs: audioInputs }), 'utf8');
  await runProcess(tools.ffmpeg, [...args, ...filterComplexFile(graph1, tools.ffmpeg), '-map', '[aout]', '-c:a', 'pcm_s24le', '-ar', '48000', '-t', total.toFixed(3), programme], { timeoutMs: 3 * 60 * 60_000, maxOutputBytes: 8 * 1024 * 1024 });
  onProgress?.({ phase: 'stems', progress: 0.4 });
  const sfxTrack = sfx?.length ? await buildSfxTrack(sfx, total, tmpRoot, tools) : null;
  const variants = [
    { name: 'dialogue', game: true },
    narration ? { name: 'voice', voice: true } : null,
    music ? { name: 'music', music: true } : null,
    sfxTrack ? { name: 'sfx', sfx: true } : null,
    { name: 'mix', game: true, voice: Boolean(narration), music: Boolean(music), sfx: Boolean(sfxTrack), master: true },
  ].filter(Boolean);
  const files = [];
  for (const [k, v] of variants.entries()) {
    const a = ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', programme];
    const count = () => a.filter(x => x === '-i').length;
    let musicInputIndex = null, narrationInputIndex = null, sfxInputIndex = null;
    if (v.music) { musicInputIndex = count(); a.push('-stream_loop', '-1', ...(musicTrimStart > 0 ? ['-ss', Number(musicTrimStart).toFixed(3)] : []), '-t', total.toFixed(3), '-i', path.resolve(music)); }
    if (v.voice) { narrationInputIndex = count(); a.push('-ss', Number(narrationTrimStart).toFixed(3), '-t', (total - narrationStart).toFixed(3), '-i', path.resolve(narration)); }
    if (v.sfx) { sfxInputIndex = count(); a.push('-i', sfxTrack); }
    const overlayAudioInputs = overlayClips.map(o => {
      if (!v.game || !(o.gain > 0) || !o.hasAudio || !o.file || /\.(png|jpe?g|webp)$/i.test(o.file) || o.at >= total - 0.05) return null;
      const d = Math.min(o.end - o.start, total - o.at), i = count();
      a.push('-vn', '-ss', o.start.toFixed(3), '-t', d.toFixed(3), '-i', o.file); return i;
    });
    const graph = path.join(tmpRoot, `stem-${v.name}.txt`);
    await writeGraph(graph, buildFilter(plan, { width: 320, height: 180, fps: 30, stage: 'audio', programAudioInput: 0, finish,
      gameGain: v.game ? Math.max(0, Math.min(2, Number(gameGain))) : 0, musicGain: Math.max(0, Math.min(1, Number(musicGain))), musicInputIndex, narrationInputIndex, narrationStart, narrationGain, sfxInputIndex,
      overlays: overlayClips, overlayInputs: overlayClips.map(() => null), overlayAudioInputs, audioRepair, voiceEnhance: ['off', 'light', 'strong'].includes(voiceEnhance) ? voiceEnhance : 'off',
      loudnessTarget: v.master && Number.isFinite(Number(loudnessTarget)) && loudnessTarget !== null ? Math.max(-24, Math.min(-9, Number(loudnessTarget))) : null, masterLimiter: Boolean(v.master) }), 'utf8');
    const out = path.join(outDir, `${String(k + 1).padStart(2, '0')}-${v.name}.wav`);
    await runProcess(tools.ffmpeg, [...a, ...filterComplexFile(graph, tools.ffmpeg), '-map', '[aout]', '-c:a', 'pcm_s24le', '-ar', '48000', '-t', total.toFixed(3), out], { timeoutMs: 2 * 60 * 60_000, maxOutputBytes: 8 * 1024 * 1024 });
    files.push({ stem: v.name, file: out, bytes: (await fs.stat(out)).size });
    onProgress?.({ phase: 'stems', progress: 0.4 + 0.6 * (k + 1) / variants.length });
  }
  return { output: files.at(-1).file, files, duration: total, stems: files.map(f => f.stem) };
}
