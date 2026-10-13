// Brand colours for filter strings: only 6-digit hex reaches FFmpeg.
export const DEFAULT_COLORS = Object.freeze({ primary: '#101315', accent: '#F7CF72', text: '#FFFFFF' });
/** Brand colours as FFmpeg 0xRRGGBB; anything that is not a 6-digit hex falls back to the default. */
export function filterColors(colors = {}) {
  const out = {};
  for (const [k, d] of Object.entries(DEFAULT_COLORS)) out[k] = `0x${(/^#?[0-9a-f]{6}$/i.test(String(colors[k] ?? '')) ? String(colors[k]) : d).replace('#', '').toUpperCase()}`;
  return out;
}

