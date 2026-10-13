// Music engine entry for the studio: compose in a worker thread, optional online providers, provider keys.
import { Worker } from 'node:worker_threads';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StudioError, DATA_ROOT } from '../paths.mjs';
import { styleList, MOODS, MUSIC_ENGINE_VERSION } from './engine.mjs';

export { styleList, MOODS, MUSIC_ENGINE_VERSION };

/** Compose + render in a worker; resolves with { file, report, stems }. */
export function composeToFile(spec, out, { timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { spec, out } });
    const timer = setTimeout(() => { worker.terminate(); reject(new StudioError('MUSIC_TIMEOUT', 'Composing took too long.')); }, timeoutMs);
    worker.once('message', m => { clearTimeout(timer); worker.terminate(); if (m.ok) resolve({ file: out, report: m.report, stems: m.stems }); else reject(new StudioError('MUSIC_FAILED', `Music could not be made: ${m.error}`)); });
    worker.once('error', e => { clearTimeout(timer); reject(new StudioError('MUSIC_FAILED', `Music could not be made: ${e.message}`)); });
  });
}

// ------------------------------------------------------------------ online providers (opt-in, user's own key)
const SETTINGS = () => path.join(DATA_ROOT, 'settings', 'music-providers.json');
async function readSettings() { try { return JSON.parse(await fs.readFile(SETTINGS(), 'utf8')); } catch { return {}; } }
export const PROVIDERS = Object.freeze({
  elevenlabs: { name: 'ElevenLabs Music', env: 'ELEVENLABS_API_KEY', site: 'https://elevenlabs.io/music', note: 'Online: only your text prompt and the length are sent; video never leaves this computer. Uses your ElevenLabs credits; check their terms for commercial use.' },
});
export async function providerStatus() {
  const s = await readSettings();
  return Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.name, configured: Boolean(process.env[p.env] || s[id]?.key), keySource: process.env[p.env] ? 'environment' : s[id]?.key ? 'saved' : null, note: p.note }));
}
/** Save (or with an empty key, remove) a provider key in the local data folder. Keys are never returned. */
export async function saveProviderKey(provider, key) {
  if (!PROVIDERS[provider]) throw new StudioError('INVALID_ARGUMENTS', `provider: ${Object.keys(PROVIDERS).join(', ')}.`);
  const value = String(key ?? '').trim();
  if (value && !/^[A-Za-z0-9_\-.]{16,200}$/.test(value)) throw new StudioError('INVALID_ARGUMENTS', 'That does not look like an API key.');
  const s = await readSettings();
  if (value) s[provider] = { key: value, savedAt: new Date().toISOString() }; else delete s[provider];
  await fs.mkdir(path.dirname(SETTINGS()), { recursive: true });
  await fs.writeFile(SETTINGS(), JSON.stringify(s, null, 2), { encoding: 'utf8', mode: 0o600 });
  return (await providerStatus()).find(p => p.id === provider);
}
async function keyFor(provider, given) {
  if (given) return String(given).trim();
  const p = PROVIDERS[provider];
  return process.env[p.env] || (await readSettings())[provider]?.key || null;
}
/** A text prompt for online generators that describes the same brief the local engine would follow. */
export function providerPrompt({ style, mood, bpm, drops = [], duration, ending = 'hit', extra = '' }) {
  const s = styleList().find(x => x.id === style);
  const parts = [`Instrumental ${s ? s.name.toLowerCase() : 'modern electronic'} track for a short social video`, s?.description?.replace(/\.$/, ''), mood ? `${mood} mood` : '', bpm ? `around ${Math.round(bpm)} BPM` : '',
    drops.length ? `big drop at ${drops.map(t => `${t.toFixed(1)} s`).join(' and ')}` : '', ending === 'hit' ? `ends with a final hit about ${Math.max(1, duration - 2.5).toFixed(1)} s in, then rings out` : 'fades out at the end', 'no vocals', extra].filter(Boolean);
  return parts.join(', ').slice(0, 4000);
}
/** ElevenLabs Music: POST /v1/music → audio bytes (mp3). */
export async function elevenLabsCompose({ prompt, seconds, apiKey, model, instrumental = true }, out) {
  const key = await keyFor('elevenlabs', apiKey);
  if (!key) throw new StudioError('PROVIDER_KEY_REQUIRED', 'Add your ElevenLabs API key first (Audio tab, or env ELEVENLABS_API_KEY).');
  const ms = Math.round(Math.max(3, Math.min(600, Number(seconds) || 30)) * 1000);
  let res;
  try {
    res = await fetch('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_192', {
      method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ prompt: String(prompt).slice(0, 4100), music_length_ms: ms, force_instrumental: Boolean(instrumental), ...(model ? { model_id: model } : {}) }),
      signal: AbortSignal.timeout(5 * 60_000),
    });
  } catch (e) { throw new StudioError('PROVIDER_FAILED', `ElevenLabs could not be reached: ${e.message}`); }
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 400).replace(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '***');
    throw new StudioError(res.status === 401 ? 'PROVIDER_KEY_INVALID' : 'PROVIDER_FAILED', `ElevenLabs answered ${res.status}: ${text || res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new StudioError('PROVIDER_FAILED', 'ElevenLabs returned no audio.');
  await fs.writeFile(out, buf);
  return { file: out, songId: res.headers.get('song-id'), bytes: buf.length };
}
