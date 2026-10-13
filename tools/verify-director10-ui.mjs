// Director 0.10 editor UI verification: Compose music in the Audio tab (style list, compose, new variation),
// ElevenLabs block present (no network call), Dutch labels, no JS errors or external requests.
// Usage: node tools/verify-director10-ui.mjs <playwright-module> <browser-exe> <new-output-dir-under-data-root> <project-id-with-an-edit>
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { DATA_ROOT, safeResolveWithin } from '../src/paths.mjs';
const [modulePath, browserPath, output, sourceProject] = process.argv.slice(2);
if (!sourceProject) throw new Error('Provide Playwright path, browser path, new output dir and a project ID with an edit.');
safeResolveWithin(DATA_ROOT, path.relative(DATA_ROOT, path.resolve(output)));
await fs.mkdir(output, { recursive: false });
const port = process.env.GAME_TRAILER_STUDIO_PORT || '32146';
const base = `http://127.0.0.1:${port}`;
const api = async (route, body) => { const r = await fetch(`${base}/api${route}`, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); const j = await r.json(); if (!j.ok) throw new Error(j.error?.message); return j; };
const { chromium } = await import(pathToFileURL(modulePath).href);
const context = await chromium.launchPersistentContext(path.join(output, 'browser-profile'), { executablePath: browserPath, headless: true, viewport: { width: 1500, height: 950 } });
const report = { checks: [], errors: [], externalRequests: [] };
const pass = name => { report.checks.push(name); console.error(`PASS ${name}`); };
const revAbove = (page, r, timeout = 180000) => page.waitForFunction(v => Number(document.querySelector('#revision').textContent.replace(/\D/g, '')) > v, r, { timeout });
const rev = page => page.locator('#revision').textContent().then(x => Number(x.replace(/\D/g, '')));
try {
  await context.route('**/*', route => { const url = new URL(route.request().url()); if (url.hostname === '127.0.0.1' && url.port === port) return route.continue(); report.externalRequests.push(url.origin); return route.abort(); });
  const copy = (await api(`/studio/projects/${sourceProject}/duplicate`, { name: 'UI check 0.10' })).project;
  const page = await context.newPage(); page.on('pageerror', e => report.errors.push(e.message)); page.on('dialog', d => d.accept());
  await page.goto(`${base}/#${copy.id}`);
  await page.locator('#lane-video .clip').first().waitFor();
  await page.click('.right .tabs [data-tab="audio"]');
  await page.waitForFunction(() => document.querySelectorAll('#mg-style option').length >= 6);
  assert.equal(await page.locator('#mg-style option[value="cinematic"]').count(), 1);
  pass('style list loads from the engine');
  await page.selectOption('#mg-style', 'house'); await page.fill('#mg-drops', 'auto');
  let r = await rev(page); await page.click('#mg-compose'); await revAbove(page, r);
  let p = (await api(`/studio/projects/${copy.id}`)).project;
  assert.match(p.options.music, /music-house-[0-9a-f]{10}\.wav$/); assert.ok(p.music?.bpm >= 118 && p.music?.bpm <= 128);
  assert.match(await page.locator('#mg-info').textContent(), /BPM/);
  pass('compose places a house track with an exact grid');
  const first = p.options.music;
  r = await rev(page); await page.click('#mg-variation'); await revAbove(page, r);
  p = (await api(`/studio/projects/${copy.id}`)).project;
  assert.notEqual(p.options.music, first);
  pass('new variation makes a different track');
  assert.equal(await page.locator('#mg-eleven').count(), 1); assert.equal(await page.locator('#mg-key').getAttribute('type'), 'password');
  pass('ElevenLabs block present (key field is a password field)');
  await page.screenshot({ path: path.join(output, 'director10.png') });
  await page.evaluate(() => localStorage.setItem('studio-lang', 'nl')); await page.reload();
  await page.locator('#lane-video .clip').first().waitFor();
  assert.match(await page.locator('.right [data-panel="audio"]').textContent(), /Muziek componeren/);
  await page.evaluate(() => localStorage.setItem('studio-lang', 'en'));
  pass('music UI translated to Dutch');
  assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []);
  pass('no JS errors or external requests');
  report.passed = true;
} catch (e) { report.passed = false; report.failure = e.stack; }
finally { await context.close(); }
console.log(JSON.stringify(report));
process.exit(report.passed ? 0 : 1);
