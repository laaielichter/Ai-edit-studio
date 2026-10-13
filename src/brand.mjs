// Brand kits: logo, colours, font, intro/outro and caption/look defaults that editors and agents
// apply with one call. Stored as JSON next to the named styles; media are referenced, never copied.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_ROOT, StudioError, writeJsonAtomic, readJson, MEDIA_EXTENSIONS } from './paths.mjs';

const ROOT = () => path.join(DATA_ROOT, 'studio', 'brands');
export const LOGO_POSITIONS = Object.freeze(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
const slug = name => String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const hex = (v, fallback, name) => {
  if (v === undefined || v === '') return fallback;
  if (!/^#?[0-9a-fA-F]{6}$/.test(String(v))) throw new StudioError('INVALID_BRAND', `${name}: use a hex colour like #FFB400.`);
  return `#${String(v).replace('#', '').toUpperCase()}`;
};
const num = (v, d, a, b, name) => {
  const n = v === undefined || v === '' ? d : Number(v);
  if (!Number.isFinite(n) || n < a || n > b) throw new StudioError('INVALID_BRAND', `${name}: between ${a} and ${b}.`);
  return n;
};
async function localFile(value, extensions, name, limit) {
  if (!value) return '';
  const file = String(value);
  if (!path.isAbsolute(file) || /^(?:\\\\|\/\/)/.test(file) || file.includes('\0')) throw new StudioError('INVALID_BRAND', `${name}: use an absolute local path.`);
  const info = await fs.stat(file).catch(() => null);
  if (!info?.isFile() || !extensions.includes(path.extname(file).toLowerCase()) || info.size > limit) throw new StudioError('INVALID_BRAND', `${name}: file not found or unsupported type.`);
  return path.resolve(file);
}

export async function normalizeBrand(input = {}) {
  const id = slug(input.name);
  if (!id) throw new StudioError('INVALID_BRAND', 'Give the brand kit a name.');
  return {
    schemaVersion: 1, id, name: String(input.name).trim().slice(0, 60),
    logo: await localFile(input.logo, ['.png', '.jpg', '.jpeg'], 'logo', 16 * 1024 ** 2),
    logoPosition: LOGO_POSITIONS.includes(input.logoPosition) ? input.logoPosition : 'top-left',
    logoScale: num(input.logoScale, 0.13, 0.05, 0.4, 'logoScale'), logoOpacity: num(input.logoOpacity, 0.9, 0.1, 1, 'logoOpacity'),
    primary: hex(input.primary, '#101315', 'primary'), accent: hex(input.accent, '#F7CF72', 'accent'), text: hex(input.text, '#FFFFFF', 'text'),
    font: await localFile(input.font, ['.ttf', '.otf'], 'font', 32 * 1024 ** 2),
    intro: await localFile(input.intro, MEDIA_EXTENSIONS, 'intro', 2 * 1024 ** 3),
    outro: await localFile(input.outro, MEDIA_EXTENSIONS, 'outro', 2 * 1024 ** 3),
    captionStyle: ['box', 'bold', 'minimal'].includes(input.captionStyle) ? input.captionStyle : undefined,
    captionPosition: ['low', 'middle', 'high'].includes(input.captionPosition) ? input.captionPosition : undefined,
    look: ['neutral', 'cinema', 'vivid', 'noir'].includes(input.look) ? input.look : undefined,
    lookStrength: input.lookStrength === undefined ? undefined : num(input.lookStrength, 0.6, 0, 1, 'lookStrength'),
    cta: input.cta === undefined ? undefined : String(input.cta).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 100),
    label: input.label === undefined ? undefined : String(input.label).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 70),
    hashtags: Array.isArray(input.hashtags) ? input.hashtags.map(h => String(h).replace(/[^\p{L}\p{N}_]/gu, '')).filter(Boolean).slice(0, 15) : [],
    updatedAt: new Date().toISOString(),
  };
}

export async function listBrands() {
  await fs.mkdir(ROOT(), { recursive: true });
  const rows = [];
  for (const name of (await fs.readdir(ROOT())).filter(n => n.endsWith('.json')).sort()) {
    try { rows.push(await readJson(path.join(ROOT(), name))); } catch { /* skip unreadable */ }
  }
  return rows;
}
export async function saveBrand(input) {
  const brand = await normalizeBrand(input);
  await fs.mkdir(ROOT(), { recursive: true });
  await writeJsonAtomic(path.join(ROOT(), `${brand.id}.json`), brand);
  return brand;
}
export async function readBrandSnapshot(id) {
  if (!slug(id)) return null;
  try { return await readJson(path.join(ROOT(), `${slug(id)}.json`)); } catch { return null; }
}
export async function getBrand(id) {
  const brand = await readBrandSnapshot(id);
  if (!brand) throw new StudioError('BRAND_NOT_FOUND', `Brand kit "${id}" does not exist. Use studio_brand {action:"list"}.`);
  return brand;
}

/** Project options a brand kit sets (the project keeps a reference; colours/font/intro/outro are read at render time). */
export function brandOptions(brand) {
  const o = { brand: brand.id };
  if (brand.logo) o.logo = brand.logo;
  for (const k of ['captionStyle', 'captionPosition', 'look', 'lookStrength']) if (brand[k] !== undefined) o[k] = brand[k];
  if (brand.cta !== undefined) o.endTitle = brand.cta;
  if (brand.label !== undefined) o.label = brand.label;
  return o;
}
/** Render-time options derived from the brand kit (numeric/hex/paths only). */
export function brandRenderOptions(brand) {
  return { fontFile: brand.font || undefined, colors: { primary: brand.primary, accent: brand.accent, text: brand.text },
    logoPosition: brand.logoPosition, logoScale: brand.logoScale, logoOpacity: brand.logoOpacity, intro: brand.intro || '', outro: brand.outro || '' };
}
