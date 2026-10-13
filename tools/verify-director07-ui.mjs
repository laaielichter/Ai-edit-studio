// Director 0.7 editor UI verification: clip finder, caption animation, layers, sound & motion,
// freeze frame, voice & loudness, QC on exports, queue, recipes, Dutch labels.
// Usage: node tools/verify-director07-ui.mjs <playwright-module> <browser-exe> <new-output-dir-under-data-root> <analyzed-project-id-with-an-export>
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
const context = await chromium.launchPersistentContext(path.join(output, 'browser-profile'), { executablePath: browserPath, headless: true,
  viewport: { width: 1500, height: 950 }, args: ['--disable-background-networking', '--autoplay-policy=no-user-gesture-required'] });
const report = { checks: [], errors: [], externalRequests: [] };
const pass = name => { report.checks.push(name); console.error(`PASS ${name}`); };
const rev = page => page.locator('#revision').textContent().then(x => Number(x.replace(/\D/g, '')));
const revAbove = (page, r, timeout = 60000) => page.waitForFunction(v => Number(document.querySelector('#revision').textContent.replace(/\D/g, '')) > v, r, { timeout });
try {
  await context.route('**/*', route => { const url = new URL(route.request().url()); if (url.hostname === '127.0.0.1' && url.port === port) return route.continue(); report.externalRequests.push(url.origin); return route.abort(); });
  // Work on a fresh copy with one rendered preview, so the check is repeatable and never touches the original project.
  const copy = (await api(`/studio/projects/${sourceProject}/duplicate`, { name: 'UI check 0.7' })).project;
  const projectId = copy.id;
  await api(`/studio/projects/${projectId}/export`, { revision: copy.revision, preview: true });
  await api(`/studio/projects/${projectId}/wait`, { timeoutSeconds: 280 });
  const page = await context.newPage(); page.on('pageerror', e => report.errors.push(e.message)); page.on('dialog', d => d.accept());
  await page.goto(`${base}/#${projectId}`);
  await page.locator('#lane-video .clip').first().waitFor();

  // Clip finder.
  await page.click('.left .tabs [data-tab="moments"]');
  await page.fill('#clips-count', '3'); await page.fill('#clips-min', '6'); await page.fill('#clips-max', '15');
  await page.click('#clips-find');
  await page.locator('#clips-list .clip-card').first().waitFor({ timeout: 60000 });
  assert.ok(await page.locator('#clips-list .clip-card').count() >= 1);
  assert.equal(await page.locator('#clips-make').isDisabled(), false);
  pass('clip finder lists ranked clips');

  // Caption animation + voice & loudness (local options, saved with Ctrl+S).
  await page.click('.right .tabs [data-tab="text"]');
  const was = (await api(`/studio/projects/${projectId}`)).project.options;
  const anim = was.captionAnimation === 'pop' ? 'highlight' : 'pop', voice = was.voiceEnhance === 'light' ? 'strong' : 'light', loud = was.loudnessTarget === -23 ? -16 : -23;
  await page.selectOption('#captionAnimation', anim); await page.selectOption('#captionCase', 'upper');
  await page.click('.right .tabs [data-tab="audio"]');
  await page.selectOption('#voiceEnhance', voice); await page.selectOption('#loudness-target', String(loud));
  let r = await rev(page); await page.keyboard.press('Control+s'); await revAbove(page, r);
  let p = (await api(`/studio/projects/${projectId}`)).project;
  assert.equal(p.options.captionAnimation, anim); assert.equal(p.options.voiceEnhance, voice); assert.equal(p.options.loudnessTarget, loud);
  pass('caption animation, voice enhance and loudness target save');

  // Sound & motion on the selected shot.
  await page.click('.right .tabs [data-tab="shot"]');
  await page.locator('#lane-video .clip').nth(1).click();
  await page.locator('#shot-audioShift').evaluate(n => { n.value = '-0.5'; n.dispatchEvent(new Event('input')); n.dispatchEvent(new Event('change')); });
  const clipsBefore = await page.locator('#lane-video .clip').count();
  await page.click('#shot-punch');
  await page.waitForFunction(n => document.querySelectorAll('#lane-video .clip').length > n, clipsBefore);
  r = await rev(page); await page.keyboard.press('Control+s'); await revAbove(page, r);
  p = (await api(`/studio/projects/${projectId}`)).project;
  assert.ok(p.plan.clips.some(c => c.audioShift === -0.5)); assert.ok(p.plan.clips.some(c => c.zoom > 1.1));
  pass('J-cut slider and punch-in zooms');

  // Freeze frame (server) and a layer (local op).
  r = await rev(page);
  await page.click('#shot-freeze'); await revAbove(page, r);
  p = (await api(`/studio/projects/${projectId}`)).project;
  assert.ok(p.sources.some(s => s.still) && p.plan.clips.some(c => c.label === 'freeze'));
  pass('freeze frame adds a still and a shot');
  await api(`/studio/projects/${projectId}/edit`, { revision: p.revision, operations: [{ op: 'add_overlay', sourceIndex: 0, start: 1, end: 3, at: 0.5, mode: 'pip', position: 'top-left' }] });
  await page.waitForFunction(() => document.querySelectorAll('#overlay-list .overlay-row').length === 1, null, { timeout: 15000 });
  await page.locator('#overlay-list select').first().selectOption('full');
  r = await rev(page); await page.keyboard.press('Control+s'); await revAbove(page, r);
  assert.equal((await api(`/studio/projects/${projectId}`)).project.options.overlays[0].mode, 'full');
  pass('layer from an agent appears live, edited in the Shot tab');

  // QC, queue, recipes.
  await page.click('.right .tabs [data-tab="deliver"]');
  await page.locator('.export-card').first().waitFor();
  await page.locator('.export-card button', { hasText: 'Check quality' }).first().click();
  await page.locator('.export-card .qc-badge:not(:empty)').first().waitFor({ timeout: 120000 });
  assert.match(await page.locator('#queue-list').textContent(), /Nothing waiting/);
  pass('Check quality writes a QC badge on the export; queue panel shown');
  await page.click('.right .tabs [data-tab="agent"]');
  await page.locator('#recipe-list .recipe-row').nth(3).waitFor();
  assert.ok((await page.locator('#recipe-list').textContent()).includes('Shorts from a long video'));
  pass('recipes listed in the Agent tab');
  await page.screenshot({ path: path.join(output, 'director07.png') });

  // Dutch.
  await page.evaluate(() => localStorage.setItem('studio-lang', 'nl')); await page.reload();
  await page.locator('#lane-video .clip').first().waitFor();
  assert.match(await page.locator('#clips-find').textContent(), /Clips zoeken/);
  assert.match(await page.locator('.right [data-panel="shot"]').textContent(), /Geluid & beweging/);
  await page.evaluate(() => localStorage.setItem('studio-lang', 'en'));
  pass('0.7 features translated to Dutch');
  assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []);
  pass('no JS errors or external requests');
  report.passed = true;
} catch (e) { report.passed = false; report.failure = e.stack; }
finally { await context.close(); }
console.log(JSON.stringify(report));
process.exit(report.passed ? 0 : 1);
