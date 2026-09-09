// Run after npm run build and test/delivery-ui-fixture.ts. Synthetic port only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? '/Applications/EZ Coder.app/Contents/Resources/sidecar/node_modules/playwright/index.mjs');
const browser = await chromium.launch({ headless: true });
const out = '.ezcoder/screenshots/step12'; fs.mkdirSync(out, { recursive: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage(); page.setDefaultTimeout(10000);
const errors = [], mutations = [], completionBodies = [], responses = [];
page.on('pageerror', e => errors.push(e.message));
page.on('request', r => { assert.equal(new URL(r.url()).port, '4320', 'isolated requests only'); if (r.method() === 'POST') mutations.push(r.url()); if (r.url().endsWith('/complete')) completionBodies.push(r.postDataJSON()); });
page.on('response', async r => { if (r.url().includes('/api/providers')) responses.push(await r.text().catch(() => '')); });
await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { if (window.denyClipboard) throw Error('synthetic denial'); window.syntheticClipboard = text; } } }));
const button = name => page.getByRole('button', { name, exact: true });
async function keyActivate(locator) { await locator.focus(); await page.keyboard.press('Enter'); }
async function disclosure(text) { const s = page.locator('summary').filter({ hasText: text }); if (!await s.evaluate(e => e.parentElement.open)) await keyActivate(s); }
async function shot(name) { await page.screenshot({ path: `${out}/${name}.png`, fullPage: true, animations: 'disabled' }); }
const lum = rgb => rgb.match(/[\d.]+/g).slice(0,3).map(Number).map(v => v/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4).reduce((s,v,i) => s+v*[.2126,.7152,.0722][i],0);
const contrast = (a,b) => (Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
try {
 await page.goto('http://127.0.0.1:4320/#connections');
 await page.getByText('Status: connected', { exact: true }).waitFor();
 await page.getByText('Status: unavailable', { exact: true }).waitFor();
 await shot('connections-connected');
 await keyActivate(button('Disconnect OpenAI')); await page.getByText('Status: disconnected', { exact: true }).waitFor();
 await keyActivate(button('Connect OpenAI')); await page.getByText(/Sign-in pending/).waitFor(); await shot('connections-pending');
 await page.getByText(/Status: connected · Sign-in success/).waitFor();
 assert.ok(responses.every(s => !s.includes('SYNTHETIC_SECRET_SENTINEL')));
 await keyActivate(page.getByRole('link', { name: 'Choose project goal and planning model', exact: true }));
 await keyActivate(page.getByRole('link', { name: 'Synthetic onboarding', exact: true }));
 await page.getByLabel('Planning provider', { exact: true }).waitFor();
 assert.equal(await page.getByLabel('Planning provider', { exact: true }).inputValue(), 'openai');
 assert.equal(await page.getByLabel('Exact planning model', { exact: true }).inputValue(), 'gpt-6-astra');
 await page.getByLabel('Planning provider', { exact: true }).selectOption('');
 await keyActivate(button('Reload latest saved state')); assert.equal(await page.getByLabel('Planning provider', { exact: true }).inputValue(), '', 'explicit local selection preserved');
 await page.getByLabel('Planning provider', { exact: true }).selectOption('openai'); await page.getByLabel('Exact planning model', { exact: true }).selectOption('gpt-6-astra');
 for (const [label,text] of [['Delivery goal','Daily whole member onboarding'],['Intended user','Synthetic members'],['Target daily workflow','Complete onboarding from first visit through durable completion'],['Current stage and unknowns','Synthetic prototype; no live acceptance']]) { const input = page.getByLabel(label, { exact: true }); await input.focus(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type(text); }
 // Both recoverable server errors and revision conflicts must preserve form drafts.
 for (const status of [503,409]) { await page.route('**/delivery/goal', r => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic save conflict; draft retained' }) })); await keyActivate(button('Save delivery settings')); await page.getByRole('alert').waitFor(); assert.equal(await page.getByLabel('Intended user', { exact: true }).inputValue(), 'Synthetic members'); await page.unroute('**/delivery/goal'); }
 await keyActivate(button('Save delivery settings')); await page.getByText('Goal saved. Define a finish line or choose optional model planning.', { exact: true }).waitFor();
 await disclosure('Optional model planning: context and external-send approval');
 await keyActivate(button('Collect local preview')); const packet = JSON.parse(await page.getByLabel('Exact context packet for approval').inputValue()); assert.equal(packet.model, 'gpt-6-astra');
 assert.equal(await button('Generate plan').isDisabled(), true);
 await shot('context-preview');
 const approved = page.waitForRequest(r => r.url().endsWith('/context/approve')); await keyActivate(button('Approve this exact packet for external planning')); assert.equal((await approved).postDataJSON().fingerprint, packet.fingerprint);
 await page.getByText('Exact context approved. Generate or Replan sends it to the selected provider.', { exact: true }).waitFor();
 await disclosure('Optional model planning: context and external-send approval'); await keyActivate(button('Generate plan')); await page.getByText('Planning: pending', { exact: true }).waitFor();
 const posts = mutations.length; let polls = 0; page.on('request', r => { if (r.url().includes('/operations/') && r.method() === 'GET') polls++; });
 await disclosure('Legacy milestone queue and reports');
 await page.getByRole('heading', { name: 'Whole guided member onboarding', exact: true }).waitFor(); assert.ok(polls >= 1); assert.equal(mutations.length, posts, 'pending polling never POSTs');
 await disclosure('Scope, acceptance and prerequisites'); await disclosure('Preview exact EZ Coder task');
 const task = await page.getByLabel('Exact task text', { exact: true }).inputValue(); assert.match(task, /whole/i);
 await keyActivate(button('Copy task for EZ Coder')); await page.waitForFunction(() => !!window.syntheticClipboard); assert.equal(await page.evaluate(() => window.syntheticClipboard), task);
 await page.evaluate(() => window.denyClipboard = true); await keyActivate(button('Copy task for EZ Coder')); assert.equal(await page.getByLabel('Copy task for EZ Coder: selectable text').inputValue(), task);
 await button('Copy task for EZ Coder').focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
 const focus = await button('Copy task for EZ Coder').evaluate(e => ({ style: getComputedStyle(e).outlineStyle, width: getComputedStyle(e).outlineWidth })); assert.notEqual(focus.style, 'none');
 const colors = await button('Copy task for EZ Coder').evaluate(e => ({ fg:getComputedStyle(e).color,bg:getComputedStyle(e).backgroundColor })); const ratio = contrast(colors.fg,colors.bg); assert.ok(ratio >= 4.5);
 await shot('delivery-desktop');
 for (const scale of [100,200]) { await page.setViewportSize({ width:320,height:900 }); await page.evaluate(s => document.documentElement.style.fontSize = `${s}%`,scale); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${scale}% reflow`); await shot(`delivery-320-${scale}`); await page.getByRole('heading', { name: 'Whole guided member onboarding', exact:true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: `${out}/delivery-320-${scale}-viewport.png`, animations:'disabled' }); }
 await page.emulateMedia({ reducedMotion:'reduce' }); assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),true); await shot('delivery-reduced-motion');
 await page.setViewportSize({ width:1280,height:900 }); await page.evaluate(() => document.documentElement.style.fontSize = '');
 await disclosure('Complete and continue: user-reported outcome'); await page.getByLabel('Delivered outcome',{exact:true}).fill('Delivered whole synthetic onboarding'); await page.getByLabel('Runtime/test evidence, unverified claims and remaining blockers',{exact:true}).fill('Synthetic browser workflow; no live acceptance claimed');
 // Commit the real fixture request, lose only its response, then retry original identity.
 await page.route('**/delivery/*/complete', async route => { await route.fetch(); await route.abort('connectionfailed'); });
 await keyActivate(button('Complete and continue')); await button('Retry original completion').waitFor(); await page.getByRole('alert').waitFor(); assert.equal(await page.getByLabel('Delivered outcome',{exact:true}).inputValue(),'Delivered whole synthetic onboarding');
 await page.unroute('**/delivery/*/complete'); await keyActivate(button('Retry original completion'));
 await page.getByRole('heading',{name:'Staff review and corrections',exact:true}).waitFor(); assert.deepEqual(completionBodies[1],completionBodies[0]);
 await page.waitForFunction(() => document.activeElement?.textContent === 'Staff review and corrections'); await shot('completion-next-focus');
 const url = page.url(); await page.reload(); await disclosure('Legacy milestone queue and reports'); await page.getByRole('heading',{name:'Staff review and corrections',exact:true}).waitFor(); assert.equal(page.url(),url);
 await disclosure('Block, reopen, next milestones and history'); await page.getByLabel('Exact prerequisite or reason to reopen').fill('Synthetic owner approval missing'); await keyActivate(button('Block current milestone')); await page.getByText('Status: blocked', { exact:true }).waitFor();
 await page.getByLabel('Exact prerequisite or reason to reopen').fill('Synthetic approval supplied'); await keyActivate(button('Reopen Staff review and corrections')); await page.getByRole('heading',{name:'Staff review and corrections',exact:true}).waitFor();
 const deliveryUrl = mutations.find(u=>u.endsWith('/goal')).replace(/\/goal$/,''); const saved = await page.evaluate(async url => (await fetch(url)).json(), deliveryUrl); assert.equal(saved.state.history.filter(e=>e.kind==='complete').length,1); assert.ok(saved.state.history.some(e=>e.kind==='block')); assert.ok(saved.state.history.some(e=>e.kind==='reopen'));
 await shot('history');
 await page.emulateMedia({ colorScheme:'dark', reducedMotion:'reduce', forcedColors:'none' });
 await page.waitForFunction(() => document.documentElement.getAttribute('data-mantine-color-scheme') === 'dark');
 const darkColors = await button('Copy task for EZ Coder').evaluate(e => ({ fg:getComputedStyle(e).color,bg:getComputedStyle(e).backgroundColor }));
 const darkRatio = contrast(darkColors.fg,darkColors.bg); assert.ok(darkRatio >= 4.5);
 await shot('delivery-dark');
 await page.emulateMedia({ forcedColors:'active' });
 assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await shot('delivery-forced-colors');
 assert.deepEqual(errors,[]);
 const result = { status:'pass', browser: await browser.version(), contrast: { primaryText:ratio, darkPrimaryText:darkRatio }, focus, pollingReads:polls, completionRequests:completionBodies.length, savedCompletions:1, screenshots:fs.readdirSync(out).filter(x=>x.endsWith('.png')).map(x=>`${out}/${x}`), unverified:['screen reader','live provider/account entitlement','true browser zoom (200% root text tested)','field performance'] }; fs.writeFileSync(`${out}/results.json`,JSON.stringify(result,null,2)); console.log(JSON.stringify(result,null,2));
} catch(e) { await shot('failure'); fs.writeFileSync(`${out}/failure.txt`, String(e.stack)); throw e; } finally { await browser.close(); }
