// Director 0.9 editor UI verification: LUT picker, auto colour, stabilise slider, push-ins, sound analysis + repair,
// sound effects, progress bar, stems/compare controls, speed-up pauses button, Dutch labels.
// Usage: node tools/verify-director09-ui.mjs <playwright-module> <browser-exe> <new-output-dir-under-data-root> <analyzed-project-id>
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
const revAbove = (page, r, timeout = 90000) => page.waitForFunction(v => Number(document.querySelector('#revision').textContent.replace(/\D/g, '')) > v, r, { timeout });
const project = async id => (await api(`/studio/projects/${id}`)).project;
try {
  await context.route('**/*', route => { const url = new URL(route.request().url()); if (url.hostname === '127.0.0.1' && url.port === port) return route.continue(); report.externalRequests.push(url.origin); return route.abort(); });
  const copy = (await api(`/studio/projects/${sourceProject}/duplicate`, { name: 'UI check 0.9' })).project;
  const id = copy.id;
  // A text and a transition so effects have something to land on.
  await api(`/studio/projects/${id}/edit`, { revision: copy.revision, operations: [{ op: 'add_text', start: 1, end: 3, text: 'Hello', style: 'callout' }] });
  const page = await context.newPage(); page.on('pageerror', e => report.errors.push(e.message)); page.on('dialog', d => d.accept());
  await page.goto(`${base}/#${id}`);
  await page.locator('#lane-video .clip').first().waitFor();

  // Look: LUT picker + strength, auto colour.
  await page.click('.right .tabs [data-tab="style"]');
  await page.waitForFunction(() => document.querySelectorAll('#lut-select option').length >= 7);
  const warm = await page.locator('#lut-select option', { hasText: 'Warm film' }).getAttribute('value');
  await page.selectOption('#lut-select', warm);
  await page.locator('#lut-strength').evaluate(n => { n.value = '0.6'; n.dispatchEvent(new Event('input')); n.dispatchEvent(new Event('change')); });
  let r = await rev(page); await page.keyboard.press('Control+s'); await revAbove(page, r);
  let p = await project(id);
  assert.ok(p.options.lut.endsWith('builtin-warm-film.cube')); assert.equal(p.options.lutStrength, 0.6);
  pass('LUT picker and strength save');
  r = await rev(page); await page.click('#color-auto'); await revAbove(page, r);
  p = await project(id);
  assert.ok(p.plan.clips.some(c => c.brightness !== undefined || c.contrast !== undefined || c.saturation !== undefined || c.temperature !== undefined));
  pass('auto colour writes shot colour controls');

  // Shot: stabilise slider, slow push-ins.
  await page.click('.right .tabs [data-tab="shot"]');
  await page.locator('#lane-video .clip').first().click();
  await page.locator('#shot-stabilize').evaluate(n => { n.value = '0.6'; n.dispatchEvent(new Event('input')); n.dispatchEvent(new Event('change')); });
  r = await rev(page); await page.keyboard.press('Control+s'); await revAbove(page, r);
  p = await project(id);
  assert.equal(p.plan.clips[0].stabilize, 0.6);
  pass('stabilise slider sets the shot');
  r = await rev(page); await page.click('#tz-push'); await revAbove(page, r);
  p = await project(id);
  assert.ok(p.plan.clips.some(c => c.zoomEnd !== undefined && c.framing === 'fill'));
  pass('slow push-ins');

  // Audio: analyse, repair, effects.
  await page.click('.right .tabs [data-tab="audio"]');
  await page.click('#repair-analyse');
  await page.waitForFunction(() => document.querySelector('#repair-info').textContent.length > 3 && !/Listening/.test(document.querySelector('#repair-info').textContent), null, { timeout: 120000 });
  await page.selectOption('#repair-hum', '60'); await page.check('#repair-declick');
  r = await rev(page); await page.click('#repair-apply'); await revAbove(page, r);
  p = await project(id);
  assert.equal(p.options.audioRepair.hum, 60); assert.equal(p.options.audioRepair.declick, true);
  pass('sound analysis and repair');
  r = await rev(page); await page.click('#sfx-auto'); await revAbove(page, r);
  await page.waitForFunction(() => /\d/.test(document.querySelector('#sfx-count').textContent));
  assert.ok((await project(id)).options.sfx.some(x => x.kind === 'pop'));
  pass('sound effects added');

  // Text: progress bar; Export: stems + compare controls; Words: speed-up button.
  await page.click('.right .tabs [data-tab="text"]');
  await page.selectOption('#progressBar', 'bottom');
  r = await rev(page); await page.keyboard.press('Control+s'); await revAbove(page, r);
  assert.equal((await project(id)).options.progressBar, 'bottom');
  await page.waitForFunction(() => document.querySelector('.progressbar') || true);
  pass('progress bar option saves');
  await page.click('.right .tabs [data-tab="deliver"]');
  assert.equal(await page.locator('#exportStems').isVisible(), true);
  assert.equal(await page.locator('#compare-last').count(), 1);
  await page.click('.right .tabs [data-tab="words"]');
  assert.equal(await page.locator('#words-speed').count(), 1);
  pass('stems, compare and speed-up controls present');
  await page.screenshot({ path: path.join(output, 'director09.png') });

  // Dutch.
  await page.evaluate(() => localStorage.setItem('studio-lang', 'nl')); await page.reload();
  await page.locator('#lane-video .clip').first().waitFor();
  assert.match(await page.locator('.right [data-panel="style"]').textContent(), /LUT & kleur matchen/);
  assert.match(await page.locator('.right [data-panel="audio"]').textContent(), /Netbrom/);
  await page.evaluate(() => localStorage.setItem('studio-lang', 'en'));
  pass('0.9 features translated to Dutch');
  assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []);
  pass('no JS errors or external requests');
  report.passed = true;
} catch (e) { report.passed = false; report.failure = e.stack; }
finally { await context.close(); }
console.log(JSON.stringify(report));
process.exit(report.passed ? 0 : 1);
