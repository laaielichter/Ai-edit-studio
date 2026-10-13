import { StudioError } from './paths.mjs';
import { TRANSITIONS, COLOR_DEFAULTS } from '../public/edit-ops.js';

export const LOOKS = Object.freeze({
  neutral: { contrast: 1, saturation: 1, brightness: 0, blue: 0, red: 0 },
  cinema: { contrast: 1.06, saturation: 0.92, brightness: -0.012, blue: 0.018, red: 0.012 },
  vivid: { contrast: 1.04, saturation: 1.14, brightness: 0, blue: 0, red: 0.006 },
  noir: { contrast: 1.10, saturation: 0, brightness: -0.008, blue: 0, red: 0 },
});

function number(value, fallback, min, max, name) {
  const n = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new StudioError('INVALID_FINISH', name + ': choose a value between ' + min + ' and ' + max + '.');
  return n;
}
function boolean(value, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new StudioError('INVALID_FINISH', name + ': expected on or off.');
  return value;
}

export function normalizeFinish(value = {}) {
  const look = value.look ?? 'neutral';
  if (!Object.hasOwn(LOOKS, look)) throw new StudioError('INVALID_FINISH', 'Unknown film look.');
  const sourceChannel = value.sourceChannel ?? 'stereo';
  if (!['stereo', 'left', 'right', 'mono'].includes(sourceChannel)) throw new StudioError('INVALID_FINISH', 'Invalid audio channel.');
  return {
    look,
    sourceChannel,
    lookStrength: number(value.lookStrength, 0.7, 0, 1, 'Film look strength'),
    exposure: number(value.exposure, 0, -0.1, 0.1, 'Exposure'),
    fadeIn: number(value.fadeIn, 0.2, 0, 3, 'Fade-in'),
    fadeOut: number(value.fadeOut, 0.65, 0, 3, 'Fade-out'),
    duckMusic: boolean(value.duckMusic, false, 'Duck music'),
    reduceRumble: boolean(value.reduceRumble, false, 'Reduce low rumble'),
  };
}

export function normalizeTransform(value = {}) {
  const framing = value.framing ?? 'fit';
  if (!['fit', 'fill'].includes(framing)) throw new StudioError('INVALID_TRANSFORM', 'Choose full frame (fit) or crop (fill).');
  const zoom = number(value.zoom, 1, 1, 2, 'Zoom');
  const zoomEnd = number(value.zoomEnd, zoom, 1, 2, 'Zoom end');
  if (framing === 'fit' && (zoom !== 1 || zoomEnd !== 1)) throw new StudioError('INVALID_TRANSFORM', 'Zoom requires an explicitly chosen crop (fill).');
  const focusX = number(value.focusX, 0.5, 0, 1, 'Horizontal focus point'), focusY = number(value.focusY, 0.5, 0, 1, 'Vertical focus point');
  // Optional pan: the focus point moves from focusX/Y to focusXEnd/YEnd over the clip (smart reframe, eased).
  const focusXEnd = number(value.focusXEnd, focusX, 0, 1, 'Horizontal focus at end'), focusYEnd = number(value.focusYEnd, focusY, 0, 1, 'Vertical focus at end');
  if (framing === 'fit' && (focusXEnd !== focusX || focusYEnd !== focusY)) throw new StudioError('INVALID_TRANSFORM', 'A focus pan requires a crop (fill).');
  return { framing, zoom, zoomEnd, focusX, focusY, focusXEnd, focusYEnd, mirror: boolean(value.mirror, false, 'Mirror') };
}

/** Per-clip transition into this clip; validated names map 1:1 to FFmpeg xfade transitions. */
export function normalizeTransition(value = {}) {
  const transition = value.transition ?? 'cut';
  if (!Object.hasOwn(TRANSITIONS, transition)) throw new StudioError('INVALID_TRANSITION', 'Unknown transition.');
  if (transition === 'cut') return { transition: 'cut', transitionSeconds: 0 };
  return { transition, transitionSeconds: number(value.transitionSeconds, 0.5, 0.1, 3, 'Transition duration') };
}

/** Per-clip colour correction and image filters; numeric only. */
export function normalizeColor(value = {}) {
  return {
    brightness: number(value.brightness, 0, -0.3, 0.3, 'Brightness'), contrast: number(value.contrast, 1, 0.5, 1.5, 'Contrast'),
    saturation: number(value.saturation, 1, 0, 2, 'Saturation'), temperature: number(value.temperature, 0, -1, 1, 'Color temperature'),
    sharpen: number(value.sharpen, 0, 0, 1, 'Sharpen'), denoise: boolean(value.denoise, false, 'Denoise'),
  };
}
export function colorFilter(value = {}, { legacyTemperature = false } = {}) {
  const c = normalizeColor(value), parts = [];
  if (c.denoise) parts.push('hqdn3d=3:2:4:3');
  if (c.brightness !== 0 || c.contrast !== 1 || c.saturation !== 1) parts.push(`eq=brightness=${c.brightness.toFixed(4)}:contrast=${c.contrast.toFixed(4)}:saturation=${c.saturation.toFixed(4)}`);
  // Temperature as a white-balance shift (−1 cool … +1 warm ≈ 8500 K … 4500 K), lightness kept. Before 0.9 a
  // shadows/midtones colour balance was used, which barely moved mid-greys (kept for FFmpeg builds without it).
  if (c.temperature !== 0 && !legacyTemperature) parts.push(`colortemperature=temperature=${Math.round(6500 - c.temperature * 2000)}:pl=1`);
  else if (c.temperature !== 0) parts.push(`colorbalance=rs=${(c.temperature * 0.12).toFixed(4)}:bs=${(-c.temperature * 0.12).toFixed(4)}:rm=${(c.temperature * 0.05).toFixed(4)}:bm=${(-c.temperature * 0.05).toFixed(4)}`);
  if (c.sharpen > 0) parts.push(`unsharp=5:5:${(c.sharpen * 1.2).toFixed(3)}:5:5:0`);
  return parts.join(',');
}
export { COLOR_DEFAULTS };

/** Numeric values only: user strings are never inserted into a filter graph. */
export function gradeFilter(value = {}) {
  const opts = normalizeFinish(value), look = LOOKS[opts.look], s = opts.lookStrength;
  const contrast = 1 + (look.contrast - 1) * s;
  const saturation = 1 + (look.saturation - 1) * s;
  const brightness = look.brightness * s + opts.exposure;
  if (contrast === 1 && saturation === 1 && brightness === 0 && !look.blue && !look.red) return '';
  return 'eq=contrast=' + contrast.toFixed(4) + ':saturation=' + saturation.toFixed(4) + ':brightness=' + brightness.toFixed(4)
    + ',colorbalance=bs=' + (look.blue * s).toFixed(4) + ':rh=' + (look.red * s).toFixed(4);
}
