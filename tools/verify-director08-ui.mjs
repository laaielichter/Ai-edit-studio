// Director 0.8 editor UI verification (Long tab): outline/sections, search, review notes, fit to length,
// range render, timeline hand-off download, proxies status, Dutch labels.
// Usage: node tools/verify-director08-ui.mjs <playwright-module> <browser-exe> <new-output-dir-under-data-root> <analyzed-project-id>
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { DATA_ROOT, safeResolveWithin } from '../src/paths.mjs';
const [modulePath, browserPath, output, sourceProject] = process.argv.slice(2);
if (!sourceProject) throw new Error('Provide Playwright path, browser path, new output dir and an analyzed project ID.');
safeResolveWithin(DATA_ROOT, path.relative(DATA_ROOT, path.resolve(output)));
await fs.mkdir(output, { recursive: false });
const port = process.env.GAME_TRAILER_STUDIO_PORT || '32146';
const base = `http://127.0.0.1:${port}`;
const api = async (route, body) => { const r = await fetch(`${base}/api${route}`, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); const j = await r.json(); if (!j.ok) throw new Error(j.error?.message); return j; };
const { chromium } = await import(pathToFileURL(modulePath).href);
const context = await chromium.launchPersistentContext(path.join(output, 'browser-profile'), { executablePath: browserPath, headless: true, acceptDownloads: true,
  viewport: { width: 1500, height: 950 }, args: ['--disable-background-networking', '--autoplay-policy=no-user-gesture-required'] });
const report = { checks: [], errors: [], externalRequests: [] };
const pass = name => { report.checks.push(name); console.error(`PASS ${name}`); };
const rev = page => page.locator('#revision').textContent().then(x => Number(x.replace(/\D/g, '')));
const revAbove = (page, r, timeout = 60000) => page.waitForFunction(v => Number(document.querySelector('#revision').textContent.replace(/\D/g, '')) > v, r, { timeout });
try {
  await context.route('**/*', route => { const url = new URL(route.request().url()); if (url.hostname === '127.0.0.1' && url.port === port) return route.continue(); report.externalRequests.push(url.origin); return route.abort(); });
  const copy = (await api(`/studio/projects/${sourceProject}/duplicate`, { name: 'UI check 0.8' })).project;
  const projectId = copy.id;
  // A transcript so search has speech to find.
  const words = Array.from({ length: 30 }, (_, i) => ({ start: 0.5 + i * 0.4, end: 0.8 + i * 0.4, text: i === 12 ? 'rocket' : `word${i}` }));
  await api(`/studio/projects/${projectId}/transcript`, { sourceIndex: 0, words, captions: false });
  const page = await context.newPage(); page.on('pageerror', e => report.errors.push(e.message)); page.on('dialog', d => d.accept(d.type() === 'prompt' ? 'Renamed part' : undefined));
  await page.goto(`${base}/#${projectId}`);
  await page.locator('#lane-video .clip').first().waitFor();
  await page.click('.right .tabs [data-tab="long"]');
  await page.locator('#outline-list .help').waitFor();
  pass('Long tab opens with an empty outline');

  // Sections.
  let r = await rev(page);
  await page.fill('#outline-name', 'Opening'); await page.click('#outline-add'); await revAbove(page, r);
  await page.locator('#outline-list .outline-row').first().waitFor();
  // A second section from an agent (shows up live), then move it to the top from the editor.
  let p = (await api(`/studio/projects/${projectId}`)).project;
  await api(`/studio/projects/${projectId}/sections`, { action: 'add', revision: p.revision, name: 'Middle', clip: p.plan.clips[Math.min(2, p.plan.clips.length - 1)].id });
  await page.waitForFunction(() => document.querySelectorAll('#outline-list .outline-row').length === 2, null, { timeout: 15000 });
  r = await rev(page);
  await page.locator('#outline-list .outline-row').nth(1).locator('button[title="Move this section up"]').click(); await revAbove(page, r);
  assert.match(await page.locator('#outline-list .outline-row').first().textContent(), /Middle/);
  p = (await api(`/studio/projects/${projectId}`)).project;
  assert.ok(p.options.sections.some(s => s.name === 'Opening'));
  pass('sections: add in the editor, agent section appears live, move up');
  r = await rev(page);
  await page.locator('#outline-list .outline-row').nth(1).locator('button[title="Rename"]').click(); await revAbove(page, r);
  assert.ok((await api(`/studio/projects/${projectId}`)).project.options.sections.some(s => s.name === 'Renamed part'));
  pass('section rename');

  // Search.
  await page.fill('#search-query', 'rocket'); await page.click('#search-run');
  await page.locator('#search-results .hit-row').first().waitFor({ timeout: 15000 });
  assert.match(await page.locator('#search-results').textContent(), /rocket/);
  pass('search finds a spoken word');

  // Review notes.
  await page.fill('#note-text', 'Music too loud here'); await page.click('#note-add');
  await page.locator('#notes-list .note-row').first().waitFor();
  assert.equal(await page.locator('#notes-count').textContent(), '1');
  await page.locator('#notes-list .note-row button', { hasText: 'Done' }).click();
  await page.waitForFunction(() => document.querySelector('#notes-list .note-row.resolved'));
  pass('review note added and resolved');

  // Timeline hand-off download.
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#handoff [data-format="edl"]')]);
  const file = path.join(output, download.suggestedFilename()); await download.saveAs(file);
  assert.match(await fs.readFile(file, 'utf8'), /^TITLE: /);
  pass('EDL downloads from the editor');

  // Fit to length (accept the confirm dialog).
  p = (await api(`/studio/projects/${projectId}`)).project;
  const target = Math.max(5, Math.floor(p.plan.actualDuration * 0.7));
  r = await rev(page);
  await page.fill('#fit-target', String(target)); await page.click('#fit-run'); await revAbove(page, r);
  p = (await api(`/studio/projects/${projectId}`)).project;
  assert.ok(p.plan.actualDuration <= target + 0.6, `${p.plan.actualDuration} > ${target}`);
  pass('fit to length shortens the edit');

  // Range render.
  await page.click('#range-render');
  await api(`/studio/projects/${projectId}/wait`, { timeoutSeconds: 280 });
  p = (await api(`/studio/projects/${projectId}`)).project;
  assert.equal(p.exports.at(-1).format, 'range');
  pass('range render from the editor');

  // Proxies status line.
  assert.ok((await page.locator('#proxy-status').textContent()).length > 5);
  pass('proxy status shown');
  await page.screenshot({ path: path.join(output, 'director08.png') });

  // Dutch.
  await page.evaluate(() => localStorage.setItem('studio-lang', 'nl')); await page.reload();
  await page.locator('#lane-video .clip').first().waitFor();
  await page.click('.right .tabs [data-tab="long"]');
  assert.match(await page.locator('.right [data-panel="long"]').textContent(), /Opbouw/);
  assert.match(await page.locator('#outline-suggest').textContent(), /Hoofdstukken voorstellen/);
  await page.evaluate(() => localStorage.setItem('studio-lang', 'en'));
  pass('0.8 features translated to Dutch');
  assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []);
  pass('no JS errors or external requests');
  report.passed = true;
} catch (e) { report.passed = false; report.failure = e.stack; }
finally { await context.close(); }
console.log(JSON.stringify(report));
process.exit(report.passed ? 0 : 1);
