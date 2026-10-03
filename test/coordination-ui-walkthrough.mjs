// Uses the existing isolated delivery-ui-fixture.ts on port 4320. No real accounts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage(); page.setDefaultTimeout(10000);
const out = '.ezcoder/screenshots/coordination'; fs.mkdirSync(out, { recursive: true });
const errors = [], mutations = [];
page.on('pageerror', e => errors.push(e.message));
page.on('request', r => { assert.equal(new URL(r.url()).port, '4320'); if (r.method() === 'POST') mutations.push(r.url()); });
await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { if (window.denyClipboard) throw Error('Fixture clipboard denial'); window.copied = text; } } }));
const button = name => page.getByRole('button', { name, exact: true });
async function activate(locator) { await locator.waitFor(); await page.waitForFunction(e => !e.disabled, await locator.elementHandle()); await locator.focus(); await page.keyboard.press('Enter'); }
async function disclosure(text) { const s = page.locator('summary').filter({ hasText: text }); if (!await s.evaluate(e => e.parentElement.open)) await activate(s); }
async function save(name, suffix) { const [response] = await Promise.all([page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith(suffix)), activate(button(name))]); assert.equal(response.status(), 200, await response.text()); return response.json(); }
const screenshot = name => page.screenshot({ path: `${out}/${name}.png`, fullPage: true, animations: 'disabled' });
let base;
const read = (url = base) => page.evaluate(async pathname => {
  const response = await fetch(pathname); if (!response.ok) throw Error(`Fixture read ${response.status}`);
  return response.json();
}, url);
const starts = () => mutations.filter(url => new URL(url).pathname === '/api/agents/runs').length;
try {
 await page.goto('http://127.0.0.1:4320/#projects');
 await activate(page.getByRole('link', { name: 'Synthetic onboarding', exact: true }));
 await page.getByRole('tab', { name: 'Work', exact: true }).click();
 for (const [label,text] of [['What are you trying to build','Bounded synthetic member pilot'],['Who uses it','Synthetic members'],['What they do with it day to day','Enroll and recover without staff intervention'],['Where it is now, and what you are unsure about','Fixture prototype; live acceptance not claimed']]) await page.getByLabel(label, { exact:true }).fill(text);
 await page.getByLabel('Who breaks the work into pieces', { exact:true }).selectOption('');
 const savedGoal = await save('Save delivery settings','/delivery/goal');
 base = `/api/projects/${savedGoal.state.projectId}/delivery`;
 await disclosure('What counts as finished');
 await page.getByLabel('What does done look like, in one line').fill('One controlled synthetic pilot');
 await page.getByLabel('Thing 1 I could watch happen', { exact:true }).fill('Authorized members complete the workflow');
 await page.getByLabel('Thing 2 I could watch happen', { exact:true }).fill('Unauthorized members are denied');
 if (!await page.getByLabel('Thing 1 you need from a person', { exact:true }).count()) await activate(button('Add something you need from a person'));
 await page.getByLabel('Thing 1 you need from a person', { exact:true }).fill('Pilot owner confirms the fixture scope');
 await page.getByLabel('Who you need it from').fill('Synthetic pilot owner');
 const replace = page.getByLabel('Replace what I had before. Work already accepted will need checking again.');
 if (await replace.count()) await replace.check();
 await save('Save this','/coordination/contract');
 await save('Start delivering this','/coordination/engage');
 await disclosure('Break the work into pieces');
 const plan = { assumptions:['Synthetic only'], milestones:['Guided enrollment','Staff correction','Operational recovery'].map((title,i)=>({ title, outcome:`Users complete ${title.toLowerCase()}`, whyNow:'Required for bounded pilot', scope:['Integrated workflow and recovery'], exclusions:[], acceptance:['Authorized case completes','Denied case cannot proceed'], sourceIds:[], humanPrerequisites:[], dependencies:i?[i-1]:[] })) };
 plan.milestones[2].outcome += '. CHANGE: implement only work.txt in the synthetic fixture workspace';
 await page.getByLabel('Paste milestone plan JSON').fill(JSON.stringify(plan));
 await page.getByLabel('I read these pieces and the order they go in').check();
 const replacePlan = page.getByLabel('Replace the old pieces. Old results stay, but the new work needs fresh proof.'); if(await replacePlan.count()) await replacePlan.check();
 await save('Save these pieces','/coordination/plan');
 await page.getByRole('heading',{name:'Send off: Guided enrollment',exact:true}).waitFor();
 await screenshot('ready-desktop');
 for(let i=0;i<3;i++) {
   await save('Get the prompt','/coordination/handoff');
   if (i === 0) {
     // Pause/resume retains the exact assignment and never implicitly starts an agent.
     const beforePause = await read(), firstHandoff = beforePause.coordination.handoffs[0];
     await save('Pause this one', '/coordination/engage');
     await page.getByText('Paused. It stays where it is until you pick it back up.', {exact:true}).waitFor();
     const paused = await read(); assert.equal(paused.coordination.engagement, 'paused');
     assert.deepEqual(paused.coordination.handoffs, beforePause.coordination.handoffs);
     assert.deepEqual(paused.state.plans, beforePause.state.plans);
     await page.reload(); await button('Pick this back up').waitFor();
     await save('Pick this back up', '/coordination/engage');
     assert.equal((await read()).coordination.engagement, 'active');
     assert.deepEqual((await read('/api/agents')).runs, []); assert.equal(starts(), 0);
     // Browser-clock aging exposes the stale UI; mutations still hit the real fixture backend.
     await page.clock.setFixedTime(Date.now() + 3 * 86400000);
     await activate(button('Reload latest saved state'));
     await page.getByRole('heading', {name:'Sent 3 days ago, nothing came back',exact:true}).waitFor();
     assert.equal(await button('Send it again').isDisabled(), true);
     assert.equal(await button('Take it back').isDisabled(), true);
     await page.getByLabel('What happened, as far as you know').fill('Synthetic tool went silent; explicitly issue a fresh assignment.');
     await screenshot('stalled-resend'); await save('Send it again', '/coordination/resend');
     await page.clock.setFixedTime(Date.now()); await activate(button('Reload latest saved state'));
     await page.getByRole('heading', {name:'Paste back the result for Guided enrollment',exact:true}).waitFor();
     const resent = await read(); assert.notEqual(resent.coordination.handoffs[0].id, firstHandoff.id);
     assert.equal(resent.coordination.reports.length, 0);
     assert.equal(resent.coordination.decisions.filter(d => d.action === 'return' && d.reportId).length, 0);
     assert.equal(starts(), 0);
     await page.clock.setFixedTime(Date.now() + 3 * 86400000); await activate(button('Reload latest saved state'));
     await page.getByRole('heading', {name:'Sent 3 days ago, nothing came back',exact:true}).waitFor();
     await page.getByLabel('What happened, as far as you know').fill('Take back the silent synthetic assignment for review.');
     await save('Take it back', '/coordination/block'); await page.clock.setFixedTime(Date.now());
     const takenBack = await read(); assert.equal(takenBack.state.plans.at(-1).milestones[0].status, 'blocked');
     assert.equal(takenBack.coordination.handoffs.length, 0);
     await disclosure('The whole picture:');
     await page.getByLabel('Reason to reopen completed work').fill('Explicitly reopen the reviewed synthetic stalled work.');
     await save('Redo Guided enrollment', '/coordination/review');
     await save('Get the prompt', '/coordination/handoff'); assert.equal(starts(), 0);
     await screenshot('stalled-reopened');
   }
   await activate(button('Use another tool'));
   await activate(button('Copy prompt'));
   const handoffId = (await read()).coordination.handoffs.at(-1).id;
   assert.ok((await page.evaluate(()=>window.copied)).includes(handoffId), 'copied prompt identifies the exact saved handoff');
   if(i===0) {
     await page.evaluate(()=>window.denyClipboard=true); await activate(button('Copy prompt'));
     assert.ok((await page.getByLabel('Copy prompt: selectable text').inputValue()).includes(handoffId), 'clipboard fallback preserves exact handoff identity');
     await page.evaluate(()=>window.denyClipboard=false);
   }
   await disclosure('Exact format your coding tool must reply in');
   const report=JSON.parse(await page.getByLabel('Required reply').inputValue());
   report.outcome='Observed synthetic browser success'; report.criteria.forEach(c=>{c.status='met';c.evidence='Synthetic scenario checked in isolated browser; not client acceptance';});
   await page.getByLabel('Paste result JSON').fill(JSON.stringify(report));
   await page.getByLabel('I read this before saving it').check();
   if(i===0) {
     await page.route('**/coordination/report',r=>r.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Fixture stale state; draft retained'})}));
     await activate(button('Save it')); await page.getByText(/Fixture stale state; draft retained/).waitFor();
     assert.deepEqual(JSON.parse(await page.getByLabel('Paste result JSON').inputValue()),report);
     await page.unroute('**/coordination/report');
     // Simulate committed request with lost response, then retry the same bound report.
     await page.route('**/coordination/report',async r=>{await r.fetch();await r.abort('connectionfailed');});
     await activate(button('Save it')); await page.getByRole('alert').filter({hasText:'Not saved'}).waitFor();
     await page.unroute('**/coordination/report');
   }
   await save('Save it','/coordination/report');
   await page.getByRole('heading',{name:`Check the work on ${plan.milestones[i].title}`,exact:true}).waitFor();
   assert.equal(await button('Looks good, move on').isDisabled(),true);
   await page.getByLabel('Acceptance evidence or reason').fill('Reviewed the synthetic evidence and remaining risks; acceptance is mine');
   await page.getByLabel("I read this and I'm happy with it").check();
   if(i===0) {
     assert.equal(await page.getByRole('button', { name: 'Send back for more work', exact: true }).isVisible(), true);
     assert.equal(await page.getByRole('button', { name: "Park it, I'm blocked", exact: true }).isVisible(), true);
     for (const [width,height] of [[1280,800],[1440,900],[768,900],[390,844]]) {
       await page.setViewportSize({width,height}); await page.evaluate(() => scrollTo(0,0));
       assert.equal(await page.locator('.workspace-list').count(), 0);
       await screenshot(`eligible-review-${width}`);
     }
     await page.setViewportSize({width:1280,height:900});
     await screenshot('evidence-review');
   }
   await save('Looks good, move on','/coordination/review');
 }
 let state=await read(); assert.equal(state.coordination.reports.length,3); assert.equal(state.coordination.decisions.filter(d=>d.action==='accept').length,3);
 await page.getByRole('heading',{name:'Chase Synthetic pilot owner',exact:true}).waitFor();
 await disclosure('Waiting on people');
 await page.getByLabel('How it got sorted').fill('Synthetic owner approved this fixture-only exercise');
 await save('Mark this sorted','/coordination/resolve');
 await page.getByRole('heading',{name:'Everything in scope is done',exact:true}).waitFor();
 await screenshot('finite-finish');
 await page.reload(); await page.getByRole('heading',{name:'Everything in scope is done',exact:true}).waitFor();
 await page.goto('http://127.0.0.1:4320/#queue'); await page.locator('[data-queue-entry]').first().click();
 await page.getByRole('heading',{name:'Everything in scope is done',exact:true}).waitFor();
 for(const scale of [100,200]) {
   await page.setViewportSize({width:320,height:900}); await page.evaluate(s=>document.documentElement.style.fontSize=`${s}%`,scale);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`320px ${scale}% reflow`); await screenshot(`finish-320-${scale}`);
 }
 await page.emulateMedia({reducedMotion:'reduce',forcedColors:'active'}); assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert.deepEqual(errors,[]); assert.ok(mutations.every(u=>!/(generate|replan|context\/approve|providers)/.test(u)));
 state=await read(); assert.equal(state.state.plans.at(-1).milestones.length,3); assert.equal(state.coordination.reports.length,3);
 // A fourth report exercises connected execution; the original three-report assertions stay above.
 await page.emulateMedia({forcedColors:'none'}); await page.evaluate(() => document.documentElement.style.fontSize = '');
 await page.setViewportSize({width:1280,height:900});
 await disclosure('The whole picture:');
 await page.getByLabel('Reason to reopen completed work').fill('Verify connected handoff with separate agent and milestone acceptance.');
 await save('Redo Operational recovery', '/coordination/review'); await save('Get the prompt', '/coordination/handoff');
 const linked = await read(), milestone = linked.state.plans.at(-1).milestones[2];
 const handoff = linked.coordination.handoffs.find(h => h.milestoneId === milestone.id);
 assert.ok(handoff); assert.equal(starts(), 0); assert.deepEqual((await read('/api/agents')).runs, []);
 const deliveryURL = page.url();
 await page.goto('http://127.0.0.1:4320/#agents?view=settings');
 await page.getByLabel('Enable local agent execution', {exact:true}).check();
 await page.getByLabel('Pause new starts (running work continues)', {exact:true}).uncheck();
 assert.equal(await button('Save execution settings').isDisabled(), true);
 await page.getByLabel('I understand these agents are not sandboxed and may use my paid account', {exact:true}).check();
 await activate(button('Save execution settings')); await page.locator('summary').filter({hasText:'Execution enabled'}).waitFor();
 assert.deepEqual((await read('/api/agents')).runs, []);
 await page.goto(deliveryURL); await activate(page.getByRole('link', {name:'Run this assignment in DAVE',exact:true}));
 await page.getByRole('heading', {name:'Assignment',exact:true}).waitFor();
 await page.waitForFunction(title => document.querySelector('input[disabled]') && [...document.querySelectorAll('input')].some(input => input.value === title), milestone.title);
 assert.equal(await page.getByLabel('Outcome in one line', {exact:true}).inputValue(), milestone.title);
 assert.equal(await page.getByLabel('Project', {exact:true}).isDisabled(), true);
 assert.equal(await page.getByLabel('Assignment', {exact:true}).getAttribute('readonly'), '');
 assert.ok((await page.getByLabel('Assignment', {exact:true}).inputValue()).includes(handoff.id));
 assert.equal(await page.getByLabel('What proves it is done (one criterion per line)', {exact:true}).inputValue(), handoff.criteria.map(c => c.text).join('\n'));
 assert.equal(starts(), 0); await activate(button('Continue')); await activate(button('Continue'));
 await page.getByText('0 dependencies · Linked delivery handoff', {exact:true}).waitFor();
 assert.equal(await button('Queue assignment').isDisabled(), true); assert.deepEqual((await read('/api/agents')).runs, []);
 await page.getByLabel('I authorize this assignment and these checks to run locally using my agent account', {exact:true}).check();
 assert.equal(starts(), 0); await screenshot('connected-explicit-start');
 const started = await save('Queue assignment', '/api/agents/runs');
 assert.equal(started.handoffId, handoff.id); assert.equal(starts(), 1);
 await page.getByRole('region', {name:'Run review actions',exact:true}).getByText('Review packet', {exact:true}).waitFor();
 const evidence = await read(`/api/agents/runs/${started.id}`);
 assert.equal(evidence.run.status, 'review'); assert.match(evidence.run.packet.diff, /implemented/);
 const imported = await read(); assert.equal(imported.coordination.reports.length, 4);
 assert.equal(imported.coordination.reports.at(-1).report.handoffId, handoff.id);
 assert.equal(imported.coordination.decisions.filter(d => d.action === 'accept').length, 3);
 await page.getByLabel('Reply, requested changes, or acceptance evidence', {exact:true}).fill('Inspected synthetic work.txt and the imported structured fixture report.');
 for (const criterion of handoff.criteria) await page.getByLabel(`I verified: ${criterion.text}`, {exact:true}).check();
 assert.equal(await button('Accept reviewed work').isDisabled(), true);
 await page.getByLabel('No automated checks are configured; I performed and describe the manual verification below', {exact:true}).check();
 await save('Accept reviewed work', '/actions');
 await page.getByRole('region', {name:'Run workspace',exact:true}).getByText('Accepted, not merged', {exact:true}).first().waitFor();
 const acceptedAgent = await read();
 assert.equal(acceptedAgent.coordination.decisions.filter(d => d.action === 'accept').length, 3);
 assert.notEqual(acceptedAgent.state.plans.at(-1).milestones[2].status, 'reported-complete');
 await activate(page.getByRole('link', {name:'Open linked delivery and milestone review',exact:true}));
 await page.getByRole('heading', {name:'Check the work on Operational recovery',exact:true}).waitFor();
 assert.equal(await button('Looks good, move on').isDisabled(), true);
 await page.getByLabel('Acceptance evidence or reason').fill('Separately reviewed the current synthetic connected result against the milestone criteria.');
 await page.getByLabel("I read this and I'm happy with it").check();
 await screenshot('connected-milestone-review'); await save('Looks good, move on', '/coordination/review');
 await page.getByRole('heading', {name:'Everything in scope is done',exact:true}).waitFor();
 await page.reload(); await page.getByRole('heading', {name:'Everything in scope is done',exact:true}).waitFor();
 const done = await read(); assert.equal(done.coordination.reports.length, 4);
 assert.equal(done.coordination.decisions.filter(d => d.action === 'accept').length, 4);
 assert.equal(done.state.plans.at(-1).milestones[2].status, 'reported-complete');
 assert.equal(starts(), 1); assert.deepEqual(errors, []);
 assert.ok(mutations.every(u => !/(generate|replan|context\/approve|providers)/.test(u)));
 // A long failed report exercises real return/park decisions after the original completion assertions.
 await disclosure('The whole picture:');
 await page.getByLabel('Reason to reopen completed work').fill('Exercise long failed evidence without accepting it.');
 await save('Redo Operational recovery', '/coordination/review');
 await save('Get the prompt', '/coordination/handoff');
 await activate(button('Use another tool')); await disclosure('Exact format your coding tool must reply in');
 const failed = JSON.parse(await page.getByLabel('Required reply').inputValue());
 failed.outcome = 'Synthetic long reported outcome. '.repeat(35);
 failed.criteria.forEach((c,index) => { c.status = index ? 'unknown' : 'unmet'; c.evidence = 'Critical synthetic finding remains unresolved.'; });
 failed.commands = [{command:'npm test',exitCode:1,evidence:'Synthetic command failed.'},{command:'npm run build',exitCode:null,evidence:'Build was not run.'},{command:'successful-check',exitCode:0,evidence:'Successful optional transcript. '.repeat(90)}];
 failed.blockers = ['Synthetic access is still missing.']; failed.risks = ['Synthetic risk requires human assessment.'];
 await page.getByLabel('Paste result JSON').fill(JSON.stringify(failed));
 await page.getByLabel('I read this before saving it').check(); await save('Save it','/coordination/report');
 await page.getByLabel('Acceptance evidence or reason').fill('Return the unresolved synthetic findings.');
 await page.getByLabel("I read this and I'm happy with it").check();
 assert.equal(await button('Looks good, move on').isDisabled(), true);
 assert.equal(await page.locator('.review-evidence').getByText(failed.blockers[0], {exact:false}).isVisible(), true);
 assert.equal(await page.locator('.review-evidence').getByText(failed.risks[0], {exact:false}).isVisible(), true);
 assert.equal(await page.getByText(failed.commands[2].evidence, {exact:true}).isVisible(), false);
 for (const [width,height] of [[1280,800],[1440,900],[768,900],[390,844],[320,900]]) {
   await page.setViewportSize({width,height}); await page.evaluate(() => scrollTo(0,0));
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   // The previous iteration's full-page screenshot briefly resizes the page and the autosize textarea re-measures
   // during it (observed 216px settling to 42px within 50ms). Wait for layout to settle; the size limit is unchanged.
   const compact = await page.getByLabel('Acceptance evidence or reason').evaluate(e => new Promise(resolve => {
     const deadline = performance.now() + 2000;
     const check = () => e.getBoundingClientRect().height < 200 ? resolve(true) : performance.now() > deadline ? resolve(false) : requestAnimationFrame(check);
     check();
   }));
   assert.ok(compact, `short review reason remains compact at ${width}px`);
   await screenshot(`failed-review-${width}`);
 }
 await page.setViewportSize({width:1280,height:800});
 await disclosure('Commands and evidence');
 assert.equal(await page.getByText(failed.commands[2].evidence, {exact:true}).isVisible(), true);
 await save('Send back for more work', '/coordination/review');
 assert.equal((await read()).coordination.decisions.at(-1).action, 'return');
 await page.getByRole('heading', {name:/3 tries on Operational recovery/}).waitFor();
 await disclosure('The whole picture:');
 await page.getByLabel('Reason to reopen completed work').fill('Exercise parking another reviewed milestone.');
 await save('Redo Staff correction', '/coordination/review');
 await save('Get the prompt', '/coordination/handoff');
 await activate(button('Use another tool')); await disclosure('Exact format your coding tool must reply in');
 const parkReport = JSON.parse(await page.getByLabel('Required reply').inputValue());
 parkReport.criteria.forEach(c => { c.status='met'; c.evidence='Synthetic reported success'; });
 await page.getByLabel('Paste result JSON').fill(JSON.stringify(parkReport)); await page.getByLabel('I read this before saving it').check(); await save('Save it','/coordination/report');
 assert.equal(await page.getByLabel("I read this and I'm happy with it").isChecked(), false);
 await page.getByLabel('Acceptance evidence or reason').fill('Park pending a separate human decision.');
 await save("Park it, I'm blocked", '/coordination/block');
 assert.equal((await read()).state.plans.at(-1).milestones[1].status, 'blocked');
 assert.deepEqual(errors, []);
 console.log(JSON.stringify({status:'pass',browser:await browser.version(),manualReports:3,reports:4,accepted:4,assignmentStarts:starts(),providerRequests:0,stalledRecovery:['resend','take back/reopen'],pauseResume:true,screenshots:out,unverified:['screen reader','live pilot','field performance','real elapsed stale time (browser clock emulated)']},null,2));
} catch(error) { await screenshot('failure'); throw error; }
finally { await browser.close(); }
