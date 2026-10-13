// Director 0.6 editor UI verification (auto-edit dialog, Words tab, reframe, publish pack, brand kit, NL).
// Usage: node tools/verify-director06-ui.mjs <playwright-module> <browser-exe> <new-output-dir-under-data-root> <analyzed-project-id>
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { DATA_ROOT, safeResolveWithin } from '../src/paths.mjs';
const [modulePath, browserPath, output, projectId] = process.argv.slice(2);
if (!projectId) throw new Error('Provide Playwright path, browser path, new output dir and an analyzed project ID.');
safeResolveWithin(DATA_ROOT, path.relative(DATA_ROOT, path.resolve(output)));
await fs.mkdir(output, { recursive: false });
const port = process.env.GAME_TRAILER_STUDIO_PORT || '32146';
const base = `http://127.0.0.1:${port}`;
const api = async (route, body, method = body ? 'POST' : 'GET') => {
  const r = await fetch(`${base}/api${route}`, { method, headers: body ? { 'Content-Type': 'application/json', 'X-Studio-Client': 'ui-check' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!j.ok) throw new Error(`${route}: ${j.error?.message}`); return j;
};
const { chromium } = await import(pathToFileURL(modulePath).href);
const context = await chromium.launchPersistentContext(path.join(output, 'browser-profile'), { executablePath: browserPath, headless: true,
  viewport: { width: 1500, height: 950 }, args: ['--disable-background-networking', '--autoplay-policy=no-user-gesture-required'] });
const report = { checks: [], errors: [], externalRequests: [] };
const pass = name => { report.checks.push(name); console.error(`PASS ${name}`); };
const waitReady = async page => { await page.waitForFunction(() => !document.querySelector('#progress') || document.querySelector('#progress').hidden, null, { timeout: 300000 }); };
try {
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' && url.port === port) return route.continue();
    report.externalRequests.push(url.origin); return route.abort();
  });
  const page = await context.newPage(); page.on('pageerror', e => report.errors.push(e.message)); page.on('dialog', d => d.accept());
  await page.goto(`${base}/#${projectId}`);
  await page.locator('#lane-video .clip').first().waitFor();
  const startRev = (await api(`/studio/projects/${projectId}`)).project.revision;

  // Director mode dialog.
  await page.click('#auto-edit-open');
  await page.locator('#auto-platforms .template-card').nth(7).waitFor();
  assert.equal(await page.locator('#auto-platforms .template-card').count(), 8);
  await page.click('#auto-platforms .template-card[data-id="reels"]');
  await page.fill('#auto-hook', 'LASER LOCK');
  await page.uncheck('#auto-render');
  await page.click('#auto-submit');
  await page.waitForFunction(() => !document.querySelector('#auto-dialog').open);
  await page.waitForFunction(rev => Number(document.querySelector('#revision').textContent.replace(/\D/g, '')) > rev, startRev, { timeout: 300000 });
  await waitReady(page);
  await page.click('.right .tabs [data-tab="check"]');
  await page.locator('#auto-report:not([hidden]) ol li').first().waitFor({ timeout: 60000 });
  assert.match(await page.locator('#auto-report').textContent(), /Instagram Reels/);
  pass('auto-edit dialog: 8 platforms, Reels with hook text, report in Check tab');

  // Words tab with an imported transcript (words array, like any external ASR).
  const p = (await api(`/studio/projects/${projectId}`)).project;
  const c0 = p.plan.clips[0];
  const words = []; for (let i = 0; i < 24; i++) words.push({ start: c0.start + i * 0.08, end: c0.start + i * 0.08 + 0.06, text: i % 7 === 3 ? 'um' : `w${i}` });
  await api(`/studio/projects/${projectId}/transcript`, { sourceIndex: c0.sourceIndex, words, language: 'en' });
  await page.click('.right .tabs [data-tab="words"]');
  await page.locator('#words .w').first().waitFor();
  assert.ok(await page.locator('#words .w').count() >= 24);
  assert.ok(await page.locator('#words .w.filler').count() >= 3);
  assert.match(await page.locator('#words-fillers').textContent(), /\(\d+\)/);
  pass('Words tab shows the transcript with fillers highlighted');
  await page.locator('#words .w').nth(5).click();
  await page.locator('#words .w').nth(8).click({ modifiers: ['Shift'] });
  assert.equal(await page.locator('#words .w.sel').count(), 4);
  await page.fill('#words-search', 'w11 w12'); assert.equal(await page.locator('#words .w.hit').count(), 2);
  const before = Number((await page.locator('#revision').textContent()).replace(/\D/g, ''));
  await page.click('#words-fillers');
  await page.waitForFunction(rev => Number(document.querySelector('#revision').textContent.replace(/\D/g, '')) > rev, before);
  await page.waitForFunction(() => document.querySelectorAll('#words .w.out').length >= 3);
  pass('select range, phrase search and "remove fillers" make a new revision; removed words are struck through');

  // Reframe + publish pack.
  await page.click('.right .tabs [data-tab="deliver"]');
  const r1 = Number((await page.locator('#revision').textContent()).replace(/\D/g, ''));
  await page.selectOption('#reframe-aspect', '1:1');
  await page.click('#reframe-all');
  await page.waitForFunction(rev => Number(document.querySelector('#revision').textContent.replace(/\D/g, '')) > rev, r1, { timeout: 120000 });
  pass('smart reframe from the Export tab');
  await page.fill('#publish-title', 'AH-64 Laser Lock');
  await page.click('#publish-make');
  await page.locator('#publish-result .thumbs img').first().waitFor({ timeout: 120000 });
  await page.waitForFunction(() => [...document.querySelectorAll('#publish-result .thumbs img')].every(i => i.complete && i.naturalWidth > 0));
  assert.ok(await page.locator('#publish-result .draft').count() >= 3);
  pass('publish pack shows thumbnails, covers and per-platform drafts');

  // Brand kit.
  await page.click('.right .tabs [data-tab="style"]');
  await page.locator('#brand-box summary').click();
  await page.fill('#brand-name', 'UI Check Brand'); await page.fill('#brand-cta', 'Wishlist now'); await page.fill('#brand-hashtags', 'indiegame, apache');
  await page.click('#brand-save');
  await page.waitForFunction(() => [...document.querySelectorAll('#brand-select option')].some(o => o.value === 'ui-check-brand'));
  await page.selectOption('#brand-select', 'ui-check-brand');
  await page.click('#brand-apply');
  await page.waitForFunction(() => document.querySelector('#endTitle').value === 'Wishlist now', null, { timeout: 30000 });
  pass('brand kit saved and applied from the Style tab');
  await page.screenshot({ path: path.join(output, 'director06.png') });

  // Dutch interface.
  await page.evaluate(() => localStorage.setItem('studio-lang', 'nl')); await page.reload();
  await page.locator('#lane-video .clip').first().waitFor();
  assert.equal((await page.locator('.right .tabs [data-tab="words"]').textContent()).trim(), 'Woorden');
  assert.match(await page.locator('#publish-make').textContent(), /thumbnails, ondertitels/);
  await page.evaluate(() => localStorage.setItem('studio-lang', 'en'));
  pass('new features are translated to Dutch');
  assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []);
  pass('no JS errors or external requests');
  report.passed = true;
} catch (e) { report.passed = false; report.failure = e.stack; }
finally { await context.close(); }
console.log(JSON.stringify(report));
process.exit(report.passed ? 0 : 1);
