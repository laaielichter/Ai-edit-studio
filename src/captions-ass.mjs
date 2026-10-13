// Animated captions (word-by-word) as an ASS script rendered by libass. User text only ever
// lands in the .ass file, never in the FFmpeg filter string; ASS override characters are neutralised.
import fs from 'node:fs';
import { filterColors } from './render-colors.mjs';

export const CAPTION_ANIMATIONS = Object.freeze({
  none: 'Static', karaoke: 'Karaoke (active word lights up)', pop: 'Pop (2–3 words bounce in)', highlight: 'Highlight (marker on the active word)', words: 'One word at a time',
});
const r2 = n => Math.round(n * 100) / 100;
function assTime(s) {
  const cs = Math.max(0, Math.round(s * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}
/** 0xRRGGBB → &HAABBGGRR (alpha 00 = opaque). */
function assColor(hex, alpha = 0) { const h = hex.replace(/^0x|#/, ''); return `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`; }
export const assText = value => String(value ?? '').replace(/[{}\\]/g, m => ({ '{': '(', '}': ')', '\\': '/' }[m])).replace(/[\u0000-\u001f\u007f]/g, ' ');

/** Split words into display lines of at most `max` characters (used for \N breaks). */
function lineBreaks(words, max) {
  const breaks = new Set(); let len = 0;
  words.forEach((w, i) => { const add = (len ? 1 : 0) + w.text.length; if (len && len + add > max) { breaks.add(i); len = w.text.length; } else len += add; });
  return breaks;
}
function joinWords(words, breaks, render) { return words.map((w, i) => `${i && breaks.has(i) ? '\\N' : i ? ' ' : ''}${render(w, i)}`).join(''); }

/**
 * cues: timeline-timed [{start,end,text,words:[{start,end,text}]}] (words optional).
 * Returns the ASS document as a string.
 */
export function buildAss(cues, { width = 1920, height = 1080, animation = 'karaoke', style = 'bold', position = 'low', colors = {}, fontName = 'Arial', upper = false } = {}) {
  const c = filterColors(colors);
  const vertical = height > width;
  const big = animation === 'pop' || animation === 'words';
  const size = Math.round(big ? (vertical ? width / 7.2 : height / 8.5) : (vertical ? width / 10.5 : height / 14));
  const outline = Math.max(2, Math.round(size / (style === 'minimal' ? 18 : 9)));
  const alignment = position === 'middle' ? 5 : position === 'high' ? 8 : 2;
  const marginV = Math.round(height * (position === 'high' ? 0.12 : position === 'middle' ? 0 : vertical ? 0.24 : 0.22)); // low captions end above the end title (y = 80%)
  const boxed = style === 'box' && !big;
  const accent = assColor(c.accent), text = assColor(c.text), black = assColor('0x000000'), box = assColor(colors.primary ? c.primary : '0x000000', 0x50);
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${fontName.replace(/[,\r\n]/g, ' ')},${size},${text},${accent},${boxed ? box : black},${assColor('0x000000', 0x70)},-1,0,0,0,100,100,0,0,${boxed ? 3 : 1},${boxed ? Math.round(size / 5) : outline},${boxed ? 0 : Math.max(1, Math.round(size / 22))},${alignment},${Math.round(width * 0.06)},${Math.round(width * 0.06)},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = [];
  const add = (start, end, body) => { if (end - start >= 0.02) events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Cap,,0,0,0,,${body}`); };
  const word = w => assText(upper ? w.text.toUpperCase() : w.text);
  const maxChars = vertical ? (big ? 11 : 16) : (big ? 20 : 30);
  for (const cue of cues) {
    const words = (cue.words?.length ? cue.words : [{ start: cue.start, end: cue.end, text: cue.text }]).filter(w => w.text);
    if (!words.length) continue;
    if (animation === 'none') { add(cue.start, cue.end, joinWords(words, lineBreaks(words, maxChars), word)); continue; }
    // Group into chunks: whole cue for karaoke/highlight, 1 word for "words", up to 3 short words for pop.
    const chunks = [];
    if (animation === 'words') words.forEach(w => chunks.push([w]));
    else if (animation === 'pop') {
      let cur = [];
      for (const w of words) { if (cur.length && (cur.length >= (vertical ? 2 : 3) || [...cur, w].map(x => x.text).join(' ').length > maxChars)) { chunks.push(cur); cur = []; } cur.push(w); }
      if (cur.length) chunks.push(cur);
    } else chunks.push(words);
    chunks.forEach((chunk, k) => {
      const breaks = lineBreaks(chunk, maxChars);
      const chunkStart = k === 0 ? Math.min(cue.start, chunk[0].start) : chunk[0].start;
      const chunkEnd = k === chunks.length - 1 ? Math.max(cue.end, chunk.at(-1).end) : chunks[k + 1][0].start;
      chunk.forEach((active, i) => {
        const start = i === 0 ? chunkStart : active.start;
        const end = i === chunk.length - 1 ? chunkEnd : chunk[i + 1].start;
        const pop = big && i === 0 ? `{\\fscx72\\fscy72\\t(0,90,\\fscx112\\fscy112)\\t(90,170,\\fscx100\\fscy100)}` : '';
        const body = joinWords(chunk, breaks, (w, j) => {
          if (j !== i) return word(w);
          if (animation === 'highlight') return `{\\3c${accent}&\\bord${Math.round(size / 4)}\\c${assColor('0x111111')}&}${word(w)}{\\r}`;
          if (animation === 'karaoke') return `{\\c${accent}&\\fscx108\\fscy108}${word(w)}{\\r}`;
          return `{\\c${accent}&}${word(w)}{\\r}`;
        });
        add(start, end, pop + body);
      });
    });
  }
  return head + events.join('\n') + '\n';
}

/** Family name from a TTF/OTF 'name' table (nameID 1), so libass can select a brand font from fontsdir. */
export function fontFamily(file) {
  try {
    const b = fs.readFileSync(file);
    const tables = b.readUInt16BE(4);
    for (let i = 0; i < tables; i++) {
      const rec = 12 + i * 16;
      if (b.toString('latin1', rec, rec + 4) !== 'name') continue;
      const off = b.readUInt32BE(rec + 8), count = b.readUInt16BE(off + 2), strings = off + b.readUInt16BE(off + 4);
      let fallback = null;
      for (let k = 0; k < count; k++) {
        const r = off + 6 + k * 12, platform = b.readUInt16BE(r), nameId = b.readUInt16BE(r + 6), len = b.readUInt16BE(r + 8), at = strings + b.readUInt16BE(r + 10);
        if (nameId !== 1) continue;
        if (platform === 3 || platform === 0) { let s = ''; for (let j = 0; j < len; j += 2) s += String.fromCharCode(b.readUInt16BE(at + j)); if (s.trim()) return s.trim(); }
        else if (platform === 1 && !fallback) fallback = b.toString('latin1', at, at + len).trim();
      }
      return fallback;
    }
  } catch { /* unreadable font */ }
  return null;
}
export { r2 };
