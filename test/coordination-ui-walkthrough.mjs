// Uses the existing isolated delivery-ui-fixture.ts on port 4320. No real accounts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? '/Applications/EZ Coder.app/Contents/Resources/sidecar/node_modules/playwright/index.mjs');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage(); page.setDefaultTimeout(10000);
const out = '.ezcoder/screenshots/coordination'; fs.mkdirSync(out, { recursive: true });
const errors = [], mutations = [];
page.on('pageerror', e => errors.push(e.message));
page.on('request', r => { assert.equal(new URL(r.url()).port, '4320'); if (r.method() === 'POST') mutations.push(r.url()); });
await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { if (window.denyClipboard) throw Error('Fixture clipboard denial'); window.copied = text; } } }));
const button = name => page.getByRole('button', { name, exact: true });
async function activate(locator) { await locator.focus(); await page.keyboard.press('Enter'); }
async function disclosure(text) { const s = page.locator('summary').filter({ hasText: text }); if (!await s.evaluate(e => e.parentElement.open)) await activate(s); }
async function save(name, suffix) { const [response] = await Promise.all([page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith(suffix)), activate(button(name))]); assert.equal(response.status(), 200, await response.text()); return response.json(); }
const screenshot = name => page.screenshot({ path: `${out}/${name}.png`, fullPage: true, animations: 'disabled' });
let base;
const read = () => page.evaluate(async url => (await fetch(url)).json(), base);
try {
 await page.goto('http://127.0.0.1:4320/#projects');
 await activate(page.getByRole('link', { name: 'Synthetic onboarding', exact: true }));
 await disclosure('Delivery goal and planning setup');
 for (const [label,text] of [['Delivery goal','Bounded synthetic member pilot'],['Intended user','Synthetic members'],['Target daily workflow','Enroll and recover without staff intervention'],['Current stage and unknowns','Fixture prototype; live acceptance not claimed']]) await page.getByLabel(label, { exact:true }).fill(text);
 await page.getByLabel('Planning provider', { exact:true }).selectOption('');
 const savedGoal = await save('Save delivery settings','/delivery/goal');
 base = `/api/projects/${savedGoal.state.projectId}/delivery`;
 await disclosure('Define or update the bounded finish line');
 await page.getByLabel('Finish-line outcome').fill('One controlled synthetic pilot');
 await page.getByLabel('Finish criterion 1', { exact:true }).fill('Authorized members complete the workflow');
 await page.getByLabel('Finish criterion 2', { exact:true }).fill('Unauthorized members are denied');
 if (!await page.getByLabel('Prerequisite 1', { exact:true }).count()) await activate(button('Add human prerequisite'));
 await page.getByLabel('Prerequisite 1', { exact:true }).fill('Pilot owner confirms the fixture scope');
 await page.getByLabel('Owner for prerequisite 1').fill('Synthetic pilot owner');
 const replace = page.getByLabel('Replace the active scope and invalidate its previous handoffs and acceptance; retain history');
 if (await replace.count()) await replace.check();
 await save('Save finish line','/coordination/contract');
 if(await button('Make this my delivery focus').count()) await save('Make this my delivery focus','/coordination/focus');
 await disclosure('Plan without a model connection');
 const plan = { assumptions:['Synthetic only'], milestones:['Guided enrollment','Staff correction','Operational recovery'].map((title,i)=>({ title, outcome:`Users complete ${title.toLowerCase()}`, whyNow:'Required for bounded pilot', scope:['Integrated workflow and recovery'], exclusions:[], acceptance:['Authorized case completes','Denied case cannot proceed'], sourceIds:[], humanPrerequisites:[], dependencies:i?[i-1]:[] })) };
 await page.getByLabel('Paste milestone plan JSON').fill(JSON.stringify(plan));
 await page.getByLabel('I reviewed this plan and its dependency order').check();
 const replacePlan = page.getByLabel('Replace this plan; retain old reports but require fresh evidence for the new plan'); if(await replacePlan.count()) await replacePlan.check();
 await save('Import reviewed milestone plan','/coordination/plan');
 await page.getByRole('heading',{name:'Next action: Guided enrollment',exact:true}).waitFor();
 await screenshot('ready-desktop');
 for(let i=0;i<3;i++) {
   await save('Prepare this assignment','/coordination/handoff');
   await activate(button('Copy implementation assignment'));
   assert.match(await page.evaluate(()=>window.copied),/handoffId/);
   if(i===0) {
     await page.evaluate(()=>window.denyClipboard=true); await activate(button('Copy implementation assignment'));
     assert.match(await page.getByLabel('Copy implementation assignment: selectable text').inputValue(),/handoffId/);
     await page.evaluate(()=>window.denyClipboard=false);
   }
   await disclosure('Exact assignment and result format');
   const report=JSON.parse(await page.getByLabel('Required result JSON').inputValue());
   report.outcome='Observed synthetic browser success'; report.criteria.forEach(c=>{c.status='met';c.evidence='Synthetic scenario checked in isolated browser; not client acceptance';});
   await page.getByLabel('Paste result JSON').fill(JSON.stringify(report));
   await page.getByLabel('I reviewed this result and its assignment identity').check();
   if(i===0) {
     await page.route('**/coordination/report',r=>r.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Fixture stale state; draft retained'})}));
     await activate(button('Save result for review')); await page.getByText(/Fixture stale state; draft retained/).waitFor();
     assert.deepEqual(JSON.parse(await page.getByLabel('Paste result JSON').inputValue()),report);
     await page.unroute('**/coordination/report');
     // Simulate committed request with lost response, then retry the same bound report.
     await page.route('**/coordination/report',async r=>{await r.fetch();await r.abort('connectionfailed');});
     await activate(button('Save result for review')); await page.getByRole('alert').filter({hasText:'Not saved'}).waitFor();
     await page.unroute('**/coordination/report');
   }
   await save('Save result for review','/coordination/report');
   await page.getByRole('heading',{name:`Review evidence: ${plan.milestones[i].title}`,exact:true}).waitFor();
   assert.equal(await button('Accept reviewed milestone').isDisabled(),true);
   await page.getByLabel('Review reason or exact blocker').fill('Reviewed the synthetic evidence and remaining risks; acceptance is mine');
   await page.getByLabel('I reviewed this evidence and accept this milestone within the saved scope, not as client signoff').check();
   if(i===0) await screenshot('evidence-review');
   await save('Accept reviewed milestone','/coordination/review');
 }
 let state=await read(); assert.equal(state.coordination.reports.length,3); assert.equal(state.coordination.decisions.filter(d=>d.action==='accept').length,3);
 await page.getByRole('heading',{name:'Resolve prerequisites or uncovered finish criteria',exact:true}).waitFor();
 await disclosure('Finish criteria, prerequisites and milestone history');
 await page.getByLabel('Resolution evidence for prerequisite 1').fill('Synthetic owner approved this fixture-only exercise');
 await save('Record prerequisite 1 resolution','/coordination/resolve');
 await page.getByText('Ready for pilot review',{exact:true}).waitFor();
 await screenshot('finite-finish');
 await page.reload(); await page.getByText('Ready for pilot review',{exact:true}).waitFor();
 await page.goto('http://127.0.0.1:4320/#queue'); await page.getByText('Chosen delivery focus',{exact:true}).waitFor();
 await page.getByText('Ready for pilot review',{exact:true}).waitFor();
 for(const scale of [100,200]) {
   await page.setViewportSize({width:320,height:900}); await page.evaluate(s=>document.documentElement.style.fontSize=`${s}%`,scale);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`320px ${scale}% reflow`); await screenshot(`finish-320-${scale}`);
 }
 await page.emulateMedia({reducedMotion:'reduce',forcedColors:'active'}); assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert.deepEqual(errors,[]); assert.ok(mutations.every(u=>!/(generate|replan|context\/approve|providers)/.test(u)));
 state=await read(); assert.equal(state.state.plans.at(-1).milestones.length,3); assert.equal(state.coordination.reports.length,3);
 console.log(JSON.stringify({status:'pass',browser:await browser.version(),reports:3,accepted:3,providerRequests:0,screenshots:out,unverified:['screen reader','live pilot','field performance']},null,2));
} catch(error) { await screenshot('failure'); throw error; }
finally { await browser.close(); }
