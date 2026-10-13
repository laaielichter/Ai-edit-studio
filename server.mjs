import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { captureManager, listWindowProcesses } from './src/capture.mjs';
import { inspectFfmpeg } from './src/ffmpeg.mjs';
import { jobManager } from './src/jobs.mjs';
import { DATA_ROOT, PROJECT_ROOT, StudioError, ensureDataRoot } from './src/paths.mjs';
import { listProjects, createProject, getProject, projectView, saveProject, analyzeProject, replanProject, exportProject, importFile, serveMedia, silenceProposal, previewFrame,
  editProject, revisionState, listHistory, diffRevisions, restoreRevision, insightsProject, reviewProject, timelineProject, storyboard, musicBeats, duplicateProject,
  listStyles, saveStyle, applyStyle, importCaptionsFile,
  autoEditProject, transcribeProject, importTranscript, readTranscript, textEditProject, reframeProject, publishPack, publishFile, listBrands, saveBrand, applyBrand, speechInfo,
  studioEvents, listQueue, cancelQueued, waitProject, findClipsProject, qcExport, freezeFrame,
  renderRange, fitDurationProject, sectionsProject, searchTool, assembleProject, syncProject, multicamProject, exportTimelineProject, commentsProject, proxiesProject,
  lutProject, colorMatchProject, stabilizeProject, musicFitProject, audioRepairProject, sfxProject, autoZoomProject, autoBrollProject, compareProject, musicProject } from './src/studio.mjs';
import { listRecipes, saveRecipe, getRecipe, startRecipe, recipeRun, listRuns } from './src/recipes.mjs';
import { setupSpeech } from './src/transcribe.mjs';
import { PLATFORMS } from './src/autoedit.mjs';
import { agentTools, callAgentTool, OPERATIONS, openApiDocument, openAiTools } from './src/agent-tools.mjs';
import { TEMPLATES } from './src/templates.mjs';
import { STUDIO_VERSION as VERSION } from './src/agent-tools.mjs';
import { isMainModule } from './src/main-module.mjs';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 32146;
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'public');
const BODY_LIMIT = 256 * 1024;
const CAPTURE_SHUTDOWN_TIMEOUT_MS = 22_000;
const CAPTURE_SHUTDOWN_POLL_MS = 250;

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
]);

function json(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(body);
}

function apiError(response, error) {
  const known = error instanceof StudioError;
  const code = known ? error.code : 'INTERNAL_ERROR';
  const status = code === 'JOB_NOT_FOUND' || code === 'PROCESS_NOT_FOUND' || code === 'ROUTE_NOT_FOUND' ? 404
    : code === 'METHOD_NOT_ALLOWED' ? 405
      : code === 'BODY_TOO_LARGE' ? 413
      : code === 'CAPTURE_ACTIVE' || code === 'OUTPUT_EXISTS' || code === 'REVISION_CONFLICT' || code === 'ENGINE_BUSY' || code === 'PROJECT_BUSY' ? 409
        : known ? 400 : 500;
  json(response, status, {
    ok: false,
    error: {
      code,
      message: known ? error.message : 'The local server encountered an unexpected error.',
      details: known ? error.details : {},
    },
  });
}

export function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new StudioError('INVALID_PORT', `Invalid local server port: ${value}.`);
  }
  return port;
}

function isLoopbackAddress(address) {
  const normalized = String(address ?? '').toLowerCase();
  return normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '::ffff:127.0.0.1';
}

function validLocalRequest(request, port) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false;
  const host = String(request.headers.host ?? '').toLowerCase();
  const validHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (!validHosts.has(host)) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const originHost = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return ['127.0.0.1', 'localhost', '::1'].includes(originHost)
      && Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)) === port;
  } catch {
    return false;
  }
}

async function readJsonBody(request, limit = BODY_LIMIT) {
  const contentType = String(request.headers['content-type'] ?? '').split(';', 1)[0].trim();
  if (contentType !== 'application/json') {
    throw new StudioError('JSON_REQUIRED', 'This local API only accepts application/json.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new StudioError('BODY_TOO_LARGE', 'API request is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new StudioError('INVALID_REQUEST', 'The API request must be a JSON object.');
    }
    return value;
  } catch (error) {
    if (error instanceof StudioError) throw error;
    throw new StudioError('INVALID_JSON', 'The API request contains invalid JSON.', { cause: error });
  }
}

const speechSetup = { running: false, done: false, error: null, log: [] };
async function doctor() {
  const storage = await ensureDataRoot(2 * 1024 ** 3);
  const info = await inspectFfmpeg({ smokeTest: true });
  const dependencies = {
    ffmpeg: { ok: true, path: info.tools.ffmpeg, version: info.version },
    ffprobe: { ok: true, path: info.tools.ffprobe, version: info.probeVersion },
    nvenc: {
      ok: info.capabilities.nvencReady,
      status: info.capabilities.nvencReady ? 'ready' : 'software fallback',
      message: info.nvencError,
    },
    windowCapture: {
      ok: info.capabilities.gdigrab,
      status: info.capabilities.gdigrab ? 'ready' : 'missing',
    },
    storageA: { ok: true, path: storage.path, freeBytes: storage.freeBytes },
    speech: await speechInfo().then(sp => ({ ok: sp.ready, status: sp.ready ? `${sp.engine} · ${sp.models.map(m => m.name).join(', ')}` : 'not installed (optional)', engine: sp.engine, setup: sp.setup })).catch(e => ({ ok: false, status: e.message })),
  };
  return {
    ok: dependencies.ffmpeg.ok && dependencies.ffprobe.ok
      && (info.capabilities.nvencReady || info.capabilities.libx264),
    schemaVersion: 1,
    dataRoot: DATA_ROOT,
    dependencies,
    capabilities: info.capabilities,
  };
}

/** In-process tool calls (recipes) go through the same HTTP surface as any agent. */
function localApi(client) {
  const port = Number(process.env.GAME_TRAILER_STUDIO_PORT || DEFAULT_PORT);
  return async (route, { method = 'GET', body } = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}/api${route}`, { method, headers: { Accept: 'application/json', 'X-Studio-Client': client, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) throw new StudioError(data.error?.code ?? 'TOOL_FAILED', data.error?.message ?? `HTTP ${r.status}`);
    return data;
  };
}
async function routeApi(request, response, url) {
  const method = request.method ?? 'GET';
  const pathname = url.pathname;
  if (method === 'GET' && pathname === '/api/health') {
    return json(response, 200, { ok: true, service: 'AI Edit Studio', schemaVersion: 2, version: VERSION, dataRoot: DATA_ROOT });
  }
  // Universal agent entry: any HTTP-capable agent can discover and call the same tools as MCP/CLI.
  if (pathname === '/api/agent/tools' && method === 'GET' && ['openai', 'openai-chat'].includes(url.searchParams.get('format'))) return json(response, 200, { ok: true, tools: openAiTools(url.searchParams.get('format') === 'openai-chat' ? 'chat' : 'responses') });
  if (pathname === '/api/agent/tools' && method === 'GET') return json(response, 200, { ok: true, tools: agentTools, operations: OPERATIONS, call: 'POST /api/agent/call {name, arguments} or POST /api/agent/tools/{name} {…arguments}', openapi: '/api/openapi.json' });
  if (pathname === '/api/openapi.json' && method === 'GET') return json(response, 200, openApiDocument(`http://127.0.0.1:${Number(process.env.GAME_TRAILER_STUDIO_PORT || DEFAULT_PORT)}`));
  const toolCall = pathname.match(/^\/api\/agent\/(?:call|tools\/(studio_[a-z_]+))$/);
  if (toolCall && method === 'POST') {
    const body = await readJsonBody(request, 12 * 1024 * 1024);
    const name = toolCall[1] ?? body.name, args = toolCall[1] ? body : (body.arguments ?? {});
    const client = String(request.headers['x-studio-client'] || 'http-agent');
    const port = Number(process.env.GAME_TRAILER_STUDIO_PORT || DEFAULT_PORT);
    const local = async (route, { method: m = 'GET', body: b } = {}) => {
      const r = await fetch(`http://127.0.0.1:${port}/api${route}`, { method: m, headers: { Accept: 'application/json', 'X-Studio-Client': client, ...(b === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: b === undefined ? undefined : JSON.stringify(b) });
      const payload = await r.json().catch(() => ({}));
      if (!r.ok) throw new StudioError(payload?.error?.code || 'API_ERROR', payload?.error?.message || `Local API error ${r.status}.`);
      return payload;
    };
    if (typeof name !== 'string') throw new StudioError('INVALID_REQUEST', 'Provide name and arguments.');
    return json(response, 200, { ok: true, tool: name, result: await callAgentTool(name, args && typeof args === 'object' ? args : {}, local) });
  }
  if (method === 'GET' && pathname === '/api/agent-setup') {
    return json(response, 200, { ok: true, node: process.execPath, mcp: path.join(PROJECT_ROOT, 'mcp.mjs'), cli: path.join(PROJECT_ROOT, 'cli.mjs'),
      port: Number(process.env.GAME_TRAILER_STUDIO_PORT || DEFAULT_PORT), version: VERSION });
  }
  if (pathname === '/api/studio/styles') {
    if (method === 'GET') return json(response, 200, { ok: true, styles: await listStyles() });
    if (method === 'POST') return json(response, 201, { ok: true, style: await saveStyle(await readJsonBody(request)) });
  }
  if (method === 'GET' && pathname === '/api/studio/templates') return json(response, 200, { ok: true, templates: TEMPLATES });
  if (method === 'GET' && pathname === '/api/studio/platforms') return json(response, 200, { ok: true, platforms: Object.entries(PLATFORMS).map(([id, p]) => ({ id, name: p.name, formats: p.formats, duration: p.duration, pace: p.pace, keep: p.keep, aspect: p.aspect })) });
  if (pathname === '/api/studio/luts') {
    if (method === 'GET') return json(response, 200, { ok: true, ...(await lutProject(null, { action: 'list' })) });
    if (method === 'POST') return json(response, 201, { ok: true, ...(await lutProject(null, { ...(await readJsonBody(request)), action: 'import' })) });
  }
  if (method === 'GET' && pathname === '/api/studio/music/styles') return json(response, 200, { ok: true, ...(await musicProject(null, { action: 'styles' })) });
  if (method === 'POST' && pathname === '/api/studio/music/provider') return json(response, 200, { ok: true, ...(await musicProject(null, { ...(await readJsonBody(request)), action: 'provider' })) });
  if (pathname === '/api/studio/brands') {
    if (method === 'GET') return json(response, 200, { ok: true, brands: await listBrands() });
    if (method === 'POST') return json(response, 201, { ok: true, brand: await saveBrand(await readJsonBody(request)) });
  }
  if (method === 'GET' && pathname === '/api/events') {
    // Server-sent events: project changes and queue updates, optionally for one project.
    const only = url.searchParams.get('projectId');
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
    response.write(`event: hello\ndata: ${JSON.stringify({ version: VERSION })}\n\n`);
    const send = e => { if (!only || e.id === only || e.type === 'queue') response.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); };
    const ping = setInterval(() => response.write(': ping\n\n'), 20000);
    studioEvents.on('project', send); studioEvents.on('queue', send);
    request.on('close', () => { clearInterval(ping); studioEvents.off('project', send); studioEvents.off('queue', send); });
    return;
  }
  if (pathname === '/api/studio/queue') {
    if (method === 'GET') return json(response, 200, { ok: true, queue: listQueue() });
    if (method === 'POST') { const body = await readJsonBody(request); return json(response, 200, { ok: true, ...cancelQueued(String(body.cancel ?? '')) }); }
  }
  if (pathname === '/api/studio/recipes') {
    if (method === 'GET') return json(response, 200, { ok: true, recipes: await listRecipes(), runs: listRuns() });
    if (method === 'POST') return json(response, 201, { ok: true, recipe: await saveRecipe(await readJsonBody(request), agentTools.map(t => t.name)) });
  }
  if (method === 'POST' && pathname === '/api/studio/recipes/run') {
    const body = await readJsonBody(request);
    const recipe = await getRecipe(String(body.name ?? ''));
    await getProject(String(body.projectId ?? ''));
    const client = `recipe:${recipe.id}`.slice(0, 40);
    const run = startRecipe(recipe, { projectId: body.projectId, inputs: body.inputs ?? {} }, (tool, args) => callAgentTool(tool, args, localApi(client)));
    return json(response, 202, { ok: true, run: { id: run.id, recipe: run.recipe, status: run.status, steps: run.steps }, poll: `studio_recipe {action:"status", runId:"${run.id}"}` });
  }
  const runMatch = pathname.match(/^\/api\/studio\/recipes\/runs\/([0-9a-f-]{36})$/);
  if (method === 'GET' && runMatch) return json(response, 200, { ok: true, run: recipeRun(runMatch[1]) });
  if (method === 'GET' && pathname === '/api/speech') return json(response, 200, { ok: true, speech: await speechInfo(), setup: speechSetup });
  if (method === 'POST' && pathname === '/api/speech/setup') {
    const body = await readJsonBody(request);
    if (speechSetup.running) throw new StudioError('ENGINE_BUSY', 'The speech engine is already being installed.');
    Object.assign(speechSetup, { running: true, log: [], error: null, done: false });
    void setupSpeech({ model: body.model ?? 'base', onLog: line => { speechSetup.log = [...speechSetup.log, line].slice(-40); } })
      .then(() => { speechSetup.done = true; }).catch(e => { speechSetup.error = e.message; }).finally(() => { speechSetup.running = false; });
    return json(response, 202, { ok: true, setup: speechSetup });
  }
  if (pathname === '/api/studio/projects') {
    if (method === 'GET') return json(response, 200, { ok: true, projects: await listProjects() });
    if (method === 'POST') {
      const body = await readJsonBody(request);
      const c = String(request.headers['x-studio-client'] || '').trim();
      return json(response, 201, { ok: true, project: await createProject({ ...body, author: body.author ?? (!c || c === 'editor' ? 'editor' : c === 'cli' ? 'agent' : c.slice(0, 40)) }) });
    }
  }
  if (method === 'POST' && pathname === '/api/studio/import') {
    request.setTimeout(30 * 60_000);
    return json(response, 201, { ok: true, imported: await importFile(request, url.searchParams.get('name') ?? '') });
  }
  const studioMatch = pathname.match(/^\/api\/studio\/projects\/([0-9a-f-]+)(?:\/(analyze|replan|export|media|silence|frame|edit|revision|history|diff|restore|insights|review|timeline|storyboard|beats|duplicate|style|captions|auto-edit|transcribe|transcript|text-edit|reframe|publish|publish-file|brand|find-clips|qc|wait|freeze|render-range|fit-duration|sections|search|assemble|sync|multicam|export-timeline|comments|proxies|lut|color-match|stabilize|music-fit|audio-repair|sfx|auto-zoom|auto-broll|compare|music))?(?:\/(source|thumbnail|export|filmstrip|storyboard|music|narration)\/([0-9a-f-]+))?$/);
  if (studioMatch) {
    const [, id, action, kind, key] = studioMatch;
    const by = client => { const c = String(client || '').trim(); return !c || c === 'editor' ? 'editor' : c === 'cli' ? 'agent' : c.slice(0, 40); };
    if (action === 'media' && ['GET', 'HEAD'].includes(method)) return serveMedia(request, response, id, kind, key);
    if (!action && method === 'GET') return json(response, 200, { ok: true, project: projectView(await getProject(id)) });
    if (!action && method === 'PATCH') {
      const body = await readJsonBody(request);
      return json(response, 200, { ok: true, project: await saveProject(id, { ...body, author: body.author ?? by(request.headers['x-studio-client']) }) });
    }
    if (method === 'GET') {
      if (action === 'revision') return json(response, 200, { ok: true, state: await revisionState(id) });
      if (action === 'history') return json(response, 200, { ok: true, history: await listHistory(id) });
      if (action === 'insights') return json(response, 200, { ok: true, insights: await insightsProject(id) });
      if (action === 'review') return json(response, 200, { ok: true, review: await reviewProject(id) });
      if (action === 'timeline') return json(response, 200, { ok: true, timeline: await timelineProject(id, Object.fromEntries(url.searchParams)) });
      if (action === 'transcript') return json(response, 200, { ok: true, transcript: await readTranscript(id, Object.fromEntries(url.searchParams)) });
      if (action === 'publish-file') {
        const file = await publishFile(id, url.searchParams.get('path') ?? '');
        const type = { '.jpg': 'image/jpeg', '.srt': 'text/plain; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json' }[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
        const data = await fs.readFile(file);
        response.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return response.end(data);
      }
      if (action === 'diff') return json(response, 200, { ok: true, diff: await diffRevisions(id, {
        from: url.searchParams.has('from') ? Number(url.searchParams.get('from')) : undefined, to: url.searchParams.has('to') ? Number(url.searchParams.get('to')) : undefined }) });
    }
    if (method === 'POST') {
      const body = await readJsonBody(request, action === 'transcript' ? 12 * 1024 * 1024 : BODY_LIMIT);
      if (['edit', 'restore', 'analyze', 'replan', 'auto-edit', 'transcribe', 'transcript', 'text-edit', 'reframe', 'brand', 'fit-duration', 'sections', 'assemble', 'multicam', 'comments'].includes(action)) body.author ??= by(request.headers['x-studio-client']);
      if (action === 'render-range') { const p = await renderRange(id, body); return json(response, 202, { ok: true, project: p, ...(p.job ? { job: p.job } : {}) }); }
      if (action === 'fit-duration') return json(response, 200, { ok: true, ...(await fitDurationProject(id, body)) });
      if (action === 'sections') return json(response, 200, { ok: true, ...(await sectionsProject(id, body)) });
      if (action === 'search') return json(response, 200, { ok: true, ...(await searchTool(id, body)) });
      if (action === 'assemble') return json(response, 200, { ok: true, ...(await assembleProject(id, body)) });
      if (action === 'sync') { request.setTimeout(900_000); return json(response, 200, { ok: true, sync: await syncProject(id, body) }); }
      if (action === 'multicam') { request.setTimeout(900_000); return json(response, 200, { ok: true, ...(await multicamProject(id, body)) }); }
      if (action === 'export-timeline') return json(response, 200, { ok: true, timelineExport: await exportTimelineProject(id, body) });
      if (action === 'comments') return json(response, 200, { ok: true, ...(await commentsProject(id, body)) });
      if (action === 'proxies') return json(response, 200, { ok: true, proxies: await proxiesProject(id, body) });
      if (['lut', 'color-match', 'stabilize', 'music-fit', 'audio-repair', 'sfx', 'auto-zoom', 'auto-broll'].includes(action)) {
        body.author ??= by(request.headers['x-studio-client']);
        if (['color-match', 'music-fit', 'audio-repair', 'stabilize'].includes(action)) request.setTimeout(900_000);
        const fn = { lut: lutProject, 'color-match': colorMatchProject, stabilize: stabilizeProject, 'music-fit': musicFitProject, 'audio-repair': audioRepairProject, sfx: sfxProject, 'auto-zoom': autoZoomProject, 'auto-broll': autoBrollProject }[action];
        return json(response, 200, { ok: true, ...(await fn(id, body)) });
      }
      if (action === 'music') { request.setTimeout(900_000); return json(response, 200, { ok: true, ...(await musicProject(id, { ...body, author: body.author ?? by(request.headers['x-studio-client']) })) }); }
      if (action === 'compare') return json(response, 202, { ok: true, ...(await compareProject(id, body)) });
      if (action === 'auto-edit') { const p = await autoEditProject(id, body); return json(response, 202, { ok: true, project: p, ...(p.job ? { job: p.job } : {}) }); }
      if (action === 'find-clips') return json(response, 200, { ok: true, ...(await findClipsProject(id, { ...body, author: body.author ?? by(request.headers['x-studio-client']) })) });
      if (action === 'qc') return json(response, 200, { ok: true, qc: await qcExport(id, body) });
      if (action === 'wait') { request.setTimeout(300_000); return json(response, 200, { ok: true, ...(await waitProject(id, body)) }); }
      if (action === 'freeze') return json(response, 200, { ok: true, ...(await freezeFrame(id, { ...body, author: body.author ?? by(request.headers['x-studio-client']) })) });
      if (action === 'transcribe') return json(response, 202, { ok: true, project: await transcribeProject(id, body) });
      if (action === 'transcript') return json(response, 200, { ok: true, ...(await importTranscript(id, body)) });
      if (action === 'text-edit') return json(response, 200, { ok: true, ...(await textEditProject(id, body)) });
      if (action === 'reframe') return json(response, 200, { ok: true, ...(await reframeProject(id, body)) });
      if (action === 'publish') return json(response, 200, { ok: true, publish: await publishPack(id, body) });
      if (action === 'brand') return json(response, 200, { ok: true, ...(await applyBrand(id, body)) });
      if (action === 'edit') return json(response, 200, { ok: true, ...(await editProject(id, body)) });
      if (action === 'restore') return json(response, 200, { ok: true, project: await restoreRevision(id, body) });
      if (action === 'storyboard') return json(response, 200, { ok: true, storyboard: await storyboard(id, body) });
      if (action === 'beats') return json(response, 200, { ok: true, beats: await musicBeats(id, body) });
      if (action === 'style') return json(response, 200, { ok: true, ...(await applyStyle(id, { ...body, author: body.author ?? by(request.headers['x-studio-client']) })) });
      if (action === 'captions') return json(response, 200, { ok: true, ...(await importCaptionsFile(id, { ...body, author: body.author ?? by(request.headers['x-studio-client']) })) });
      if (action === 'duplicate') return json(response, 201, { ok: true, project: await duplicateProject(id, { ...body, author: body.author ?? by(request.headers['x-studio-client']) }) });
      if (action === 'silence') return json(response, 200, { ok: true, proposal: await silenceProposal(id, body) });
      if (action === 'frame') return json(response, 200, { ok: true, frame: await previewFrame(id, body) });
      if (action === 'analyze') return json(response, 202, { ok: true, project: await analyzeProject(id, body) });
      if (action === 'replan') return json(response, 200, { ok: true, project: await replanProject(id, body) });
      if (action === 'export') { const p = await exportProject(id, body); return json(response, 202, { ok: true, project: p, ...(p.job ? { job: p.job } : {}) }); }
    }
    throw new StudioError('METHOD_NOT_ALLOWED', 'Method not allowed.');
  }
  if (method === 'GET' && pathname === '/api/doctor') {
    return json(response, 200, await doctor());
  }
  if (method === 'GET' && pathname === '/api/jobs') {
    return json(response, 200, { ok: true, jobs: await jobManager.list() });
  }
  if (method === 'POST' && pathname === '/api/jobs') {
    const job = await jobManager.create(await readJsonBody(request));
    return json(response, 202, { ok: true, job });
  }
  const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (method === 'GET' && jobMatch) {
    return json(response, 200, { ok: true, job: await jobManager.get(decodeURIComponent(jobMatch[1])) });
  }
  if (method === 'GET' && pathname === '/api/processes') {
    const processes = await listWindowProcesses(url.searchParams.get('query') ?? '');
    return json(response, 200, { ok: true, processes });
  }
  if (method === 'GET' && pathname === '/api/capture/status') {
    return json(response, 200, { ok: true, capture: await captureManager.status() });
  }
  if (method === 'POST' && pathname === '/api/capture/start') {
    const capture = await captureManager.start(await readJsonBody(request));
    return json(response, 201, { ok: true, capture });
  }
  if (method === 'POST' && pathname === '/api/capture/stop') {
    await readJsonBody(request);
    const capture = await captureManager.stop();
    const pending = ['stopping', 'finalizing'].includes(capture.state);
    return json(response, pending ? 202 : 200, { ok: true, capture });
  }
  const knownPath = new Set([
    '/api/health',
    '/api/doctor',
    '/api/jobs',
    '/api/processes',
    '/api/capture/status',
    '/api/capture/start',
    '/api/capture/stop',
  ]).has(pathname) || Boolean(jobMatch);
  if (knownPath) throw new StudioError('METHOD_NOT_ALLOWED', 'Method not allowed for this local API route.');
  throw new StudioError('ROUTE_NOT_FOUND', 'This local API route does not exist.');
}

async function serveStatic(request, response, url) {
  if ((request.method ?? 'GET') !== 'GET' && request.method !== 'HEAD') {
    throw new StudioError('METHOD_NOT_ALLOWED', 'Method not allowed.');
  }
  const requestPath = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const target = path.resolve(PUBLIC_ROOT, requestPath);
  const relative = path.relative(PUBLIC_ROOT, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new StudioError('PATH_OUTSIDE_ROOT', 'Invalid web path.');
  }
  let content;
  try {
    content = await fs.readFile(target);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new StudioError('ROUTE_NOT_FOUND', 'File not found.');
    throw error;
  }
  response.writeHead(200, {
    'Content-Type': MIME_TYPES.get(path.extname(target).toLowerCase()) ?? 'application/octet-stream',
    'Content-Length': content.length,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(request.method === 'HEAD' ? undefined : content);
}

export function createStudioServer({ port = DEFAULT_PORT } = {}) {
  const validatedPort = validatePort(port);
  const server = http.createServer(async (request, response) => {
    try {
      if (!validLocalRequest(request, validatedPort)) {
        return json(response, 403, { ok: false, error: { code: 'LOCAL_ONLY', message: 'Only local Studio requests are allowed.' } });
      }
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${validatedPort}`);
      if (url.pathname.startsWith('/api/')) await routeApi(request, response, url);
      else await serveStatic(request, response, url);
    } catch (error) {
      if (!response.headersSent) apiError(response, error);
      else response.destroy();
    }
  });
  server.requestTimeout = 30 * 60_000;
  server.headersTimeout = 15_000;
  return server;
}

export async function startServer({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  const validatedPort = validatePort(port);
  const normalizedHost = String(host).trim().toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1'].includes(normalizedHost)) {
    throw new StudioError('LOCAL_ONLY', 'AI Edit Studio may only listen on a loopback address.');
  }
  await ensureDataRoot(0);
  const server = createStudioServer({ port: validatedPort });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(validatedPort, normalizedHost, resolve);
  });
  console.log(`AI Edit Studio: http://${normalizedHost}:${validatedPort}`);
  return server;
}

export async function shutdownServer(server) {
  try {
    let state = await captureManager.status();
    if (state.active || ['starting', 'recording'].includes(state.state)) {
      try {
        state = await captureManager.stop();
      } catch {
        state = await captureManager.status();
      }
    }
    const deadline = Date.now() + CAPTURE_SHUTDOWN_TIMEOUT_MS;
    while (state.active || ['stopping', 'finalizing'].includes(state.state)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.min(CAPTURE_SHUTDOWN_POLL_MS, remaining),
      ));
      state = await captureManager.status();
    }
  } catch {
    // Process exit still continues; capture state retains its own diagnostics.
  }
  await new Promise((resolve) => server.close(resolve));
}

export function installShutdownHandlers(server) {
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void shutdownServer(server).then(
      () => process.exit(0),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  return close;
}

const invokedDirectly = isMainModule(import.meta.url);
if (invokedDirectly) {
  const port = Number(process.env.GAME_TRAILER_STUDIO_PORT || DEFAULT_PORT);
  const server = await startServer({ port });
  installShutdownHandlers(server);
}
