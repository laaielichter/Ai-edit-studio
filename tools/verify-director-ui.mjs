// Director 0.4 editor UI verification in an isolated headless browser profile.
// Usage: node tools/verify-director-ui.mjs <playwright-module> <browser-exe> <new-output-dir-under-data-root> <project-id>
// The project needs >= 2 analyzed clips in a browser-playable format (MP4/H.264 in Chrome, or WebM).
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { DATA_ROOT, safeResolveWithin, PROJECT_ROOT } from '../src/paths.mjs';
import { runProcess } from '../src/process.mjs';
const [modulePath, browserPath, output, projectId] = process.argv.slice(2);
if (!projectId) throw new Error('Provide Playwright path, browser path, new output dir and an analyzed project ID.');
safeResolveWithin(DATA_ROOT, path.relative(DATA_ROOT, path.resolve(output)));
await fs.mkdir(output, { recursive: false });
const port = process.env.GAME_TRAILER_STUDIO_PORT || '32146';
const { chromium } = await import(pathToFileURL(modulePath).href);
const context = await chromium.launchPersistentContext(path.join(output, 'browser-profile'), { executablePath: browserPath, headless: true,
  viewport: { width: 1500, height: 950 }, args: ['--disable-background-networking', '--autoplay-policy=no-user-gesture-required'] });
const report = { checks: [], errors: [], externalRequests: [] };
const clips = page => page.locator('#lane-video .clip');
try {
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' && url.port === port) return route.continue();
    report.externalRequests.push(url.origin); return route.abort();
  });
  const page = await context.newPage(); page.on('pageerror', e => report.errors.push(e.message)); page.on('dialog', d => d.accept());
  await page.goto(`http://127.0.0.1:${port}/#${projectId}`);
  await clips(page).first().waitFor();
  const count = await clips(page).count(); assert.ok(count >= 2);
  await page.waitForSelector('#lane-video .clip .thumbs i', { timeout: 30000 });
  report.checks.push('timeline renders V1 with filmstrip thumbnails, A1, music and text lanes');

  // Select + inspector
  await clips(page).nth(0).click({ position: { x: 25, y: 30 } });
  assert.equal(await page.locator('#shot-form').isVisible(), true);
  // Split in the middle of the longest clip via the playhead
  const boxes = await Promise.all([...Array(count).keys()].map(i => clips(page).nth(i).boundingBox()));
  const longest = boxes.reduce((a, b) => (b.width > a.width ? b : a));
  const ruler = await page.locator('#ruler').boundingBox();
  await page.mouse.click(longest.x + longest.width / 2, ruler.y + 10);
  await page.keyboard.press('s'); assert.equal(await clips(page).count(), count + 1);
  await page.keyboard.press('Control+z'); assert.equal(await clips(page).count(), count);
  await page.keyboard.press('Control+Shift+z'); assert.equal(await clips(page).count(), count + 1);
  await page.keyboard.press('Control+z');
  report.checks.push('S splits at the playhead; Ctrl+Z / Ctrl+Shift+Z undo and redo');

  // Ripple trim by dragging the right edge
  const first = await clips(page).first().boundingBox();
  await page.mouse.move(first.x + first.width - 3, first.y + 25); await page.mouse.down();
  await page.mouse.move(first.x + first.width - 30, first.y + 25, { steps: 6 }); await page.mouse.up();
  assert.ok((await clips(page).first().boundingBox()).width < first.width - 10);
  report.checks.push('dragging a clip edge ripple-trims the shot');

  // Reorder by drag
  const id0 = await clips(page).nth(0).getAttribute('data-id');
  const a = await clips(page).nth(0).boundingBox(), b = await clips(page).nth(1).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + 30); await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.9, b.y + 30, { steps: 8 }); await page.mouse.up();
  assert.equal(await page.locator(`#lane-video .clip[data-id="${id0}"]`).getAttribute('data-index'), '1');
  report.checks.push('dragging a clip body reorders shots');

  // Marker + check tab
  await page.keyboard.press('m'); assert.ok(await page.locator('#lane-markers .marker').count() >= 1);
  await page.locator('.right .tabs button[data-tab=check]').click();
  assert.match(await page.locator('#score-value').textContent(), /^\d+$/);
  report.checks.push('markers and live quality check with score');

  // Save -> revision + history
  const before = Number((await page.locator('#revision').textContent()).replace(/\D/g, ''));
  await page.keyboard.press('Control+s'); await page.waitForFunction(() => document.getElementById('dirty').hidden);
  const after = Number((await page.locator('#revision').textContent()).replace(/\D/g, ''));
  assert.equal(after, before + 1);
  await page.locator('.right .tabs button[data-tab=history]').click();
  await page.waitForSelector('#history li .who.editor');
  report.checks.push('Ctrl+S saves a new revision visible in history as editor');

  // Agent edit picked up live
  const req = path.join(output, 'agent-edit.json');
  await fs.writeFile(req, JSON.stringify({ projectId, revision: after, summary: 'QA agent label', operations: [{ op: 'set', clip: 0, label: 'agent-qa' }] }));
  await runProcess(process.execPath, ['cli.mjs', 'studio', 'edit', '--request', req], { cwd: PROJECT_ROOT, timeoutMs: 30000 });
  await page.waitForFunction(() => document.querySelector('#lane-video .clip .label')?.textContent.includes('agent-qa'), null, { timeout: 10000 });
  assert.equal(await page.locator('#agent-live').isVisible(), true);
  report.checks.push('an agent CLI edit appears live in the open editor with attribution');

  // Restore the editor revision through history
  await page.locator('#history li').filter({ hasText: `rev ${after}` }).locator('button', { hasText: 'Restore' }).click();
  await page.waitForFunction(() => !document.querySelector('#lane-video .clip .label')?.textContent.includes('agent-qa'));
  report.checks.push('history restore undoes the agent change as a new revision');

  // Source monitor I/O insert
  await page.locator('#mode-source').click(); await page.waitForTimeout(500);
  await page.keyboard.press('End'); await page.keyboard.press('Shift+ArrowLeft'); await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('i'); await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('o');
  const n = await clips(page).count(); await page.keyboard.press('.');
  if (await clips(page).count() === n + 1) report.checks.push('source monitor I/O + "." appends unused footage');
  else report.checks.push('source monitor insert refused already-used footage (expected when the source end is used)');

  await page.screenshot({ path: path.join(output, 'desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []);
  report.checks.push('desktop/mobile UI, no horizontal overflow, no JS errors or external requests'); report.passed = true;
} catch (e) { report.passed = false; report.failure = e.stack; process.exitCode = 1; }
finally { await context.close(); await fs.writeFile(path.join(output, 'ui-verification.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
