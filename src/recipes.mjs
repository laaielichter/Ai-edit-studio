// Recipes: multi-step agent workflows run by the engine in one call. Steps are ordinary tool calls;
// asynchronous steps are awaited with studio_wait. Values: "$projectId", "$revision" (fresh before each
// step), "$item" (inside forEach), "$inputs.<name>".
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_ROOT, StudioError, writeJsonAtomic, readJson } from './paths.mjs';

export const BUILTIN_RECIPES = Object.freeze({
  'shorts-from-long': {
    name: 'Shorts from a long video', description: 'Find the best clips, make one project per clip (platform look, captions, vertical reframe), render each, check it and make thumbnails + post drafts.',
    inputs: { count: 5, platform: 'tiktok', minSeconds: 15, maxSeconds: 60 },
    steps: [
      { tool: 'studio_find_clips', arguments: { projectId: '$projectId', count: '$inputs.count', platform: '$inputs.platform', minSeconds: '$inputs.minSeconds', maxSeconds: '$inputs.maxSeconds', create: true, render: true }, save: 'clips' },
      { tool: 'studio_qc', forEach: 'clips', arguments: { projectId: '$item' }, optional: true },
      { tool: 'studio_publish_pack', forEach: 'clips', arguments: { projectId: '$item', platforms: ['tiktok', 'reels', 'shorts'] }, optional: true },
    ],
  },
  'podcast-clean': {
    name: 'Clean talking-head / podcast', description: 'Transcribe locally, remove filler words and long pauses, enhance the voice, −16 LUFS, render 16:9 with captions.',
    inputs: { language: 'auto' },
    steps: [
      { tool: 'studio_transcribe', arguments: { projectId: '$projectId', language: '$inputs.language' }, optional: true },
      { tool: 'studio_text_edit', arguments: { projectId: '$projectId', revision: '$revision', removeFillers: true, removePauses: { min: 0.9, keep: 0.2 }, smooth: true }, optional: true },
      { tool: 'studio_edit', arguments: { projectId: '$projectId', revision: '$revision', summary: 'Voice enhance + podcast loudness', operations: [{ op: 'set_options', options: { voiceEnhance: 'strong', loudnessTarget: -16, captionAnimation: 'none' } }] } },
      { tool: 'studio_render', arguments: { projectId: '$projectId', revision: '$revision', formats: ['landscape'], queue: true } },
      { tool: 'studio_qc', arguments: { projectId: '$projectId' } },
    ],
  },
  'social-pack': {
    name: 'Social pack', description: 'Auto-edit for TikTok/Reels, render, check the render and make thumbnails + post drafts.',
    inputs: { platform: 'tiktok', hookText: '' },
    steps: [
      { tool: 'studio_auto_edit', arguments: { projectId: '$projectId', platform: '$inputs.platform', hookText: '$inputs.hookText', render: true, queue: true } },
      { tool: 'studio_qc', arguments: { projectId: '$projectId' } },
      { tool: 'studio_publish_pack', arguments: { projectId: '$projectId', platforms: ['tiktok', 'reels', 'shorts'] } },
    ],
  },
  'game-trailer': {
    name: 'Game trailer', description: 'Trailer cut (hook, build-up, dip to black finale), 1440p + 9:16 + WhatsApp, QC and publish pack.',
    inputs: { title: '', cta: 'Wishlist now' },
    steps: [
      { tool: 'studio_auto_edit', arguments: { projectId: '$projectId', platform: 'trailer', title: '$inputs.title', cta: '$inputs.cta', render: true, queue: true } },
      { tool: 'studio_qc', arguments: { projectId: '$projectId' } },
      { tool: 'studio_publish_pack', arguments: { projectId: '$projectId', platforms: ['youtube', 'steam', 'x'] } },
    ],
  },
});

const ROOT = () => path.join(DATA_ROOT, 'studio', 'recipes');
const slug = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
export function validateRecipe(recipe, tools) {
  if (!recipe || !Array.isArray(recipe.steps) || !recipe.steps.length || recipe.steps.length > 30) throw new StudioError('INVALID_RECIPE', 'A recipe has 1 to 30 steps.');
  for (const [i, step] of recipe.steps.entries()) {
    if (!tools.includes(step.tool) || ['studio_recipe'].includes(step.tool)) throw new StudioError('INVALID_RECIPE', `Step ${i + 1}: unknown or disallowed tool ${step.tool}.`);
    if (step.arguments && (typeof step.arguments !== 'object' || Array.isArray(step.arguments))) throw new StudioError('INVALID_RECIPE', `Step ${i + 1}: arguments must be an object.`);
  }
  return recipe;
}
export async function listRecipes() {
  const own = [];
  try { for (const n of (await fs.readdir(ROOT())).filter(n => n.endsWith('.json'))) { try { own.push(await readJson(path.join(ROOT(), n))); } catch { /* skip */ } } } catch { /* none yet */ }
  return [...Object.entries(BUILTIN_RECIPES).map(([id, r]) => ({ id, builtIn: true, ...r })), ...own];
}
export async function saveRecipe(input, tools) {
  const id = slug(input.name);
  if (!id || BUILTIN_RECIPES[id]) throw new StudioError('INVALID_RECIPE', 'Give the recipe a new name.');
  const recipe = validateRecipe({ id, name: String(input.name).slice(0, 60), description: String(input.description ?? '').slice(0, 300), inputs: input.inputs ?? {}, steps: input.steps }, tools);
  await fs.mkdir(ROOT(), { recursive: true });
  await writeJsonAtomic(path.join(ROOT(), `${id}.json`), recipe);
  return recipe;
}
export async function getRecipe(id) {
  if (BUILTIN_RECIPES[id]) return { id, builtIn: true, ...BUILTIN_RECIPES[id] };
  try { return await readJson(path.join(ROOT(), `${slug(id)}.json`)); } catch { throw new StudioError('RECIPE_NOT_FOUND', `Recipe "${id}" does not exist. Use studio_recipe {action:"list"}.`); }
}

function resolve(value, scope) {
  if (typeof value === 'string') {
    if (value === '$projectId') return scope.projectId;
    if (value === '$revision') return scope.revision;
    if (value === '$item') return scope.item;
    const m = value.match(/^\$inputs\.([a-zA-Z0-9_]+)$/);
    if (m) return scope.inputs[m[1]];
    return value;
  }
  if (Array.isArray(value)) return value.map(v => resolve(v, scope));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, scope)]).filter(([, v]) => v !== undefined && v !== ''));
  return value;
}

const runs = new Map();
export function recipeRun(id) { const r = runs.get(id); if (!r) throw new StudioError('RUN_NOT_FOUND', 'Unknown recipe run.'); return r; }
export function listRuns() { return [...runs.values()].slice(-20).reverse().map(({ id, recipe, status, projectId, startedAt, finishedAt, step, steps }) => ({ id, recipe, status, projectId, startedAt, finishedAt, step, steps })); }

/** Start a recipe in the background. call(tool, args) runs a tool; returns the run record immediately. */
export function startRecipe(recipe, { projectId, inputs = {} }, call) {
  const run = { id: randomUUID(), recipe: recipe.id, name: recipe.name, projectId, status: 'running', step: 0, steps: recipe.steps.length, log: [], results: {}, startedAt: new Date().toISOString() };
  runs.set(run.id, run);
  while (runs.size > 50) runs.delete(runs.keys().next().value);
  const scope = { projectId, inputs: { ...(recipe.inputs ?? {}), ...inputs }, revision: null };
  const wait = async pid => { for (let i = 0; i < 40; i++) { const w = await call('studio_wait', { projectId: pid, until: 'idle', timeoutSeconds: 280 }); if (!w.timedOut) return w.project; } throw new StudioError('WAIT_TIMEOUT', 'Gave up waiting after 3 hours.'); };
  (async () => {
    for (const [i, step] of recipe.steps.entries()) {
      run.step = i + 1;
      const items = step.forEach ? (run.results[step.forEach] ?? []) : [null];
      for (const item of items) {
        const pid = item ?? projectId;
        try {
          const project = await wait(pid);
          Object.assign(scope, { item, revision: project.revision });
          const args = resolve(step.arguments ?? {}, scope);
          const result = await call(step.tool, args);
          const summary = result.project ? `rev ${result.project.revision} · ${result.project.status}${result.job ? ` · queued #${result.job.position}` : ''}` : result.qc ? `QC ${result.qc.score}/100, ${result.qc.loudness ?? '—'} LUFS` : result.clips ? `${result.clips.length} clips` : result.publish ? 'publish pack ready' : 'ok';
          run.log.push({ step: i + 1, tool: step.tool, projectId: pid, ok: true, summary, at: new Date().toISOString() });
          if (step.save === 'clips') run.results.clips = (result.created ?? []).map(c => c.projectId);
          if (step.tool === 'studio_qc') (run.results.qc ??= []).push({ projectId: pid, score: result.qc?.score, passed: result.qc?.passed, loudness: result.qc?.loudness, issues: result.qc?.issues?.map(i => i.code) });
          if (step.tool === 'studio_publish_pack') (run.results.publish ??= []).push(result.publish?.folder);
        } catch (e) {
          run.log.push({ step: i + 1, tool: step.tool, projectId: pid, ok: false, error: `${e.code ?? 'FAILED'}: ${e.message}`, at: new Date().toISOString() });
          if (!step.optional) { run.status = 'failed'; run.finishedAt = new Date().toISOString(); return; }
        }
      }
    }
    for (const pid of [projectId, ...(run.results.clips ?? [])]) await wait(pid).catch(() => {});
    run.status = 'done'; run.finishedAt = new Date().toISOString();
  })().catch(e => { run.status = 'failed'; run.log.push({ ok: false, error: e.message }); run.finishedAt = new Date().toISOString(); });
  return run;
}
