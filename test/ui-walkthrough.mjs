// Uses an already-installed browser tool; adds no application dependency.
// Start test/ui-fixture.ts first. Screenshots must remain synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ headless: true });
const out = '.ezcoder/screenshots';
fs.mkdirSync(out, { recursive: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const base = 'http://127.0.0.1:4318';
// Deliberately deny clipboard so recovery is exercised without OS permissions.
await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('fixture denial'); } } }));
async function keyboardTo(label) {
  for (let n = 0; n < 100; n++) {
    if (await page.evaluate((text) => document.activeElement?.textContent?.trim() === text, label)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Keyboard could not reach ${label}`);
}
const contrast = (fg, bg) => {
  const lum = (rgb) => rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => v / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, n) => sum + v * [.2126, .7152, .0722][n], 0);
  const a = lum(fg), b = lum(bg);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
};
let primaryContrast;
let secondaryContrast;
try {
  const started = performance.now();
  await page.goto(base);
  await page.locator('[data-attention-id]').first().waitFor();
  const identifyMs = Math.round(performance.now() - started);
  const colors = await page.getByRole('button', { name: 'Handled', exact: true }).first().evaluate((e) => ({ fg: getComputedStyle(e).color, bg: getComputedStyle(e).backgroundColor }));
  primaryContrast = contrast(colors.fg, colors.bg);
  const secondary = await page.locator('.mantine-Text-root').filter({ hasText: /^Source / }).first().evaluate((e) => ({ fg: getComputedStyle(e).color, bg: getComputedStyle(document.body).backgroundColor }));
  secondaryContrast = contrast(secondary.fg, secondary.bg);
  assert.ok(primaryContrast >= 4.5);
  assert.ok(secondaryContrast >= 4.5);
  const itemId = await page.locator('[data-attention-id]').first().getAttribute('data-attention-id');
  await page.screenshot({ path: `${out}/decisions-desktop.png`, fullPage: true, animations: 'disabled', animations: 'disabled', animations: 'disabled', animations: 'disabled', animations: 'disabled' });
  await keyboardTo('View project');
  const focusStyle = await page.evaluate(() => ({ outline: getComputedStyle(document.activeElement).outlineStyle, width: getComputedStyle(document.activeElement).outlineWidth }));
  assert.notEqual(focusStyle.outline, 'none');
  await page.keyboard.press('Enter');
  await page.getByRole('region', { name: /Project details:/ }).waitFor();
  const detailUrl = page.url();
  await keyboardTo('Copy handoff');
  await page.keyboard.press('Enter');
  await page.getByLabel('Copy handoff: selectable text').waitFor();
  assert.match(await page.getByLabel('Copy handoff: selectable text').inputValue(), /Directory:/);
  await page.screenshot({ path: `${out}/project-desktop.png`, fullPage: true });
  await page.goBack();
  await page.locator(`[data-attention-id="${itemId}"]`).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'View project');
  await page.goForward();
  assert.equal(page.url(), detailUrl);
  await page.goBack();
  await keyboardTo('Handled');
  await page.keyboard.press('Enter');
  await page.waitForFunction((id) => !document.querySelector(`[data-attention-id="${id}"]`), itemId);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Decision queue');
  await keyboardTo('Undo last action');
  await page.keyboard.press('Enter');
  await page.locator(`[data-attention-id="${itemId}"]`).waitFor();
  assert.match(await page.getByRole('status').allTextContents().then((texts) => texts.join(' ')), /Reopened locally/);
  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  await page.getByLabel('Search projects by name or full path').fill('does-not-exist');
  await page.getByText('No matching projects. Clear the search to see the directory.').waitFor();
  await page.getByLabel('Search projects by name or full path').fill('export');
  await page.getByRole('link', { name: 'Synthetic export portal', exact: true }).click();
  await page.reload();
  await page.getByRole('region', { name: /Project details:/ }).waitFor();
  assert.equal(await page.getByLabel('Search projects by name or full path').inputValue(), 'export');
  await page.setViewportSize({ width: 320, height: 900 });
  await page.screenshot({ path: `${out}/project-narrow.png`, fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'project reflow');
  await page.getByRole('link', { name: 'Decisions', exact: true }).click();
  await page.screenshot({ path: `${out}/decisions-narrow.png`, fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'queue reflow');
  await page.evaluate(() => document.documentElement.style.fontSize = '200%');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '200% text reflow');
  await page.screenshot({ path: `${out}/decisions-200-percent.png`, fullPage: true });
  await page.evaluate(() => document.documentElement.style.fontSize = '');
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none' });
  // Read failure preserves content and an explicit Retry works.
  await page.route('**/api/refresh', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  assert.ok(await page.locator('[data-attention-id]').count());
  await page.unroute('**/api/refresh');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].some((b) => b.textContent === 'Retry'));
  // Exercise actual empty queue via local fixture actions, then restore each revision.
  const snapshot = await (await fetch(`${base}/api/portfolio`)).json();
  assert.ok(snapshot.active.every((p) => p.name.startsWith('Synthetic')));
  const ids = snapshot.inbox.map((i) => i.id);
  try {
    for (const id of ids) assert.equal((await fetch(`${base}/api/attention/${id}/handled`, { method: 'POST' })).status, 200);
    await page.goto(base);
    await page.getByText('No current decisions in checked evidence', { exact: true }).waitFor();
    await page.screenshot({ path: `${out}/empty-queue.png`, fullPage: true, animations: 'disabled' });
  } finally {
    for (const id of ids) assert.equal((await fetch(`${base}/api/attention/${id}/undo`, { method: 'POST' })).status, 200);
  }
  // Clock-controlled visible-only polling and focused-content deferral.
  const timed = await context.newPage();
  await timed.clock.install();
  let reads = 0;
  timed.on('request', (r) => { if (r.url().endsWith('/api/portfolio')) reads++; });
  await timed.goto(base);
  await timed.locator('[data-attention-id]').first().waitFor();
  await timed.getByRole('link', { name: 'View project', exact: true }).first().focus();
  const originalFocus = await timed.evaluate(() => document.activeElement?.id);
  await timed.clock.runFor(60_001);
  await timed.getByRole('button', { name: 'Apply update' }).waitFor();
  assert.equal(await timed.evaluate(() => document.activeElement?.id), originalFocus);
  assert.equal(reads, 2);
  await timed.getByRole('button', { name: 'Pause auto-updates' }).click();
  await timed.clock.runFor(120_001);
  assert.equal(reads, 2, 'paused updates stop reads');
  await timed.getByRole('button', { name: 'Resume auto-updates' }).click();
  await timed.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }));
  await timed.clock.runFor(120_001);
  assert.equal(reads, 2, 'hidden pages do not poll');
  const returned = timed.waitForResponse((r) => r.url().endsWith('/api/portfolio'));
  await timed.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await returned;
  assert.equal(reads, 3, 'return refreshes once');
  await timed.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'pass', syntheticFirstDecisionRenderedMs: identifyMs, contrast: { primaryText: primaryContrast.toFixed(2), secondaryText: secondaryContrast.toFixed(2) }, keyboardFlow: 'project, copy fallback, Back/Forward, handled, undo', reflow: '320px and 200% text', states: 'search empty, clipboard denied, read failure/retry, reduced motion, forced colors', updates: 'minute TTL, pause, hidden-tab silence, return refresh, focus preserved', screenReader: 'unverified' }, null, 2));
} finally { await browser.close(); }
