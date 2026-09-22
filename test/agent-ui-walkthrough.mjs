// Run with test/agent-ui-fixture.ts after npm run build. All work is synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(15000);
const errors = []; page.on('pageerror', e => errors.push(e.message));
page.on('request', r => assert.equal(new URL(r.url()).port, '4323', 'fixture-only traffic'));
const out = '.ezcoder/screenshots/agent-platform'; fs.mkdirSync(out, { recursive: true });
const button = name => page.getByRole('button', { name, exact: true });
const activate = async locator => { await locator.focus(); await page.keyboard.press('Enter'); };
const shot = async name => {
  // Let font/viewport ResizeObservers settle before measuring a full-page image.
  await page.evaluate(async () => { await document.fonts.ready; for (let i = 0; i < 3; i++) await new Promise(resolve => requestAnimationFrame(resolve)); });
  return page.screenshot({ path: `${out}/${name}.png`, fullPage: true, animations: 'disabled' });
};
const read = pathname => page.evaluate(async url => {
  const response = await fetch(url); if (!response.ok) throw Error(`Fixture read ${response.status}`);
  return response.json();
}, pathname);
const currentRun = () => read(`/api/agents/runs/${new URL(page.url()).hash.match(/^#agents\/([^?]+)/)[1]}`);
const review = () => page.getByRole('region', { name: 'Run review actions', exact: true }).getByText('Review packet', { exact: true }).waitFor();
const reply = () => page.getByLabel('Reply, requested changes, or acceptance evidence', { exact: true });
const perform = async (name, action) => {
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/actions') && response.request().method() === 'POST' && response.request().postDataJSON().action === action),
    activate(button(name)),
  ]);
  assert.equal(response.status(), 200, await response.text());
};
const nextReview = async (name, action) => {
  const { run } = await currentRun(); await perform(name, action);
  // Wait for the new turn in the rendered diagnostics, not the old review panel.
  await page.getByText(new RegExp(`^Turn ${run.turn + 1} ·`)).waitFor({ state: 'attached' });
  await review();
};
const historical = async (id, packet) => {
  const details = page.locator('details').filter({ has: page.locator('summary', { hasText: /^Retained evidence history/ }) });
  if (!await details.evaluate(element => element.open)) await details.locator('summary').click();
  await page.getByLabel('Previous review packet', { exact: true }).selectOption(String(id));
  await page.waitForFunction(expected => {
    const text = document.querySelector('[aria-label="Historical evidence"]')?.textContent;
    return text && JSON.stringify(JSON.parse(text)) === JSON.stringify(expected);
  }, packet);
};
try {
  await page.goto('http://127.0.0.1:4323/#agents');
  await page.getByText('No agent runs yet', { exact: true }).waitFor();
  await shot('disabled');
  await activate(page.getByRole('link', { name: 'Execution settings', exact: true }));
  await page.getByLabel('Enable local agent execution', { exact: true }).check();
  await page.getByLabel('Pause new starts (running work continues)', { exact: true }).uncheck();
  assert.equal(await button('Save execution settings').isDisabled(), true);
  await page.getByLabel('I understand these agents are not sandboxed and may use my paid account', { exact: true }).check();
  await activate(button('Save execution settings'));
  await page.locator('summary').filter({ hasText: 'Execution enabled' }).waitFor();
  await activate(page.getByRole('link', { name: 'New assignment', exact: true }));
  await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Synthetic agent project' });
  await page.getByLabel('Outcome in one line', { exact: true }).fill('Verify connected delivery');
  await page.getByLabel('Assignment', { exact: true }).fill('CHANGE WAIT_PERMISSION');
  await page.getByLabel('What proves it is done (one criterion per line)', { exact: true }).fill('The fixture file is implemented');
  await activate(button('Continue'));
  await activate(button('Add check'));
  await page.getByLabel('Check 1 label', { exact: true }).fill('Fixture check');
  await page.getByLabel('Check 1 executable', { exact: true }).fill('node');
  await activate(button('Add argument'));
  await page.getByLabel('Check 1 argument 1', { exact: true }).fill('-e');
  await activate(button('Add argument'));
  await page.getByLabel('Check 1 argument 2', { exact: true }).fill('if(!require("fs").readFileSync("work.txt","utf8").includes("implemented"))process.exit(1);console.log("fixture verified")');
  await activate(button('Continue'));
  await page.getByLabel('I authorize this assignment and these checks to run locally using my agent account', { exact: true }).check();
  // A rejected request preserves the whole draft; retry is explicit.
  await page.route('**/api/agents/runs', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic temporary failure' }) }));
  await activate(button('Queue assignment')); await page.getByText(/^Synthetic temporary failure\./).waitFor();
  assert.equal(await page.getByLabel('Assignment', { exact: true }).inputValue(), 'CHANGE WAIT_PERMISSION');
  await page.unroute('**/api/agents/runs'); await activate(button('Queue assignment'));
  await button('Allow this edit').waitFor(); await shot('permission-desktop');
  await activate(button('Allow this edit')); await page.getByRole('region', { name: 'Run review actions', exact: true }).getByText('Review packet', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
  await page.getByRole('region', { name: 'Workspace diff', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Checks', exact: true }).click();
  await page.getByLabel('Live updates', { exact: true }).uncheck();
  await activate(button('Run approved checks')); await page.getByLabel('Live updates', { exact: true }).check();
  await page.getByText('Fixture check: passed', { exact: true }).waitFor();
  await page.getByLabel('Reply, requested changes, or acceptance evidence', { exact: true }).fill('Inspected the diff and observed the passing fixture check.');
  await page.getByRole('tab', { name: 'Activity', exact: true }).click();
  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
  await page.waitForResponse(response => response.url().includes('/api/agents/runs/') && response.request().method() === 'GET');
  assert.equal(await page.getByLabel('Reply, requested changes, or acceptance evidence', { exact: true }).inputValue(), 'Inspected the diff and observed the passing fixture check.');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('link', { name: 'All runs', exact: true }).click();
  assert.equal(await page.getByLabel('Reply, requested changes, or acceptance evidence', { exact: true }).inputValue(), 'Inspected the diff and observed the passing fixture check.');
  await page.getByLabel('I verified: The fixture file is implemented', { exact: true }).check();
  // A retained passing packet cannot replace current checks, even for unchanged files.
  const passed = await currentRun();
  assert.equal(passed.run.packet.checks[0].exitCode, 0);
  await activate(button('Refresh evidence (invalidates previous checks)'));
  await page.getByText('0 passing / 1 configured checks', { exact: true }).waitFor();
  await historical(passed.history[0].id, passed.run.packet);
  assert.equal(await button('Accept reviewed work').isDisabled(), true);
  assert.deepEqual((await currentRun()).run.packet.checks, []);
  await shot('retained-pass-current-unchecked');
  // A new turn changes the workspace; historical success is still not current evidence.
  await reply().fill('CHANGE FOLLOWUP'); await nextReview('Reply / request changes', 'reply');
  const changed = await currentRun();
  assert.notEqual(changed.run.packet.fingerprint, passed.run.packet.fingerprint);
  assert.equal(await page.getByLabel('I verified: The fixture file is implemented', { exact: true }).isChecked(), false);
  await page.getByRole('tab', { name: 'Checks', exact: true }).click();
  await activate(button('Run approved checks')); await page.getByText('Fixture check: failed (1)', { exact: true }).waitFor();
  await historical(passed.history[0].id, passed.run.packet);
  await reply().fill('The old passing snapshot does not verify this revision.');
  await page.getByLabel('I verified: The fixture file is implemented', { exact: true }).check();
  assert.equal(await button('Accept reviewed work').isDisabled(), true);
  assert.equal((await currentRun()).run.packet.checks[0].exitCode, 1);
  await shot('retained-pass-current-failed');
  // Restore the requested content through a real fixture turn and re-run approved checks.
  await reply().fill('CHANGE'); await nextReview('Reply / request changes', 'reply');
  assert.equal(await page.getByLabel('I verified: The fixture file is implemented', { exact: true }).isChecked(), false);
  await activate(button('Run approved checks')); await page.getByText('Fixture check: passed', { exact: true }).waitFor();
  await reply().fill('Inspected the diff and observed the passing fixture check.');
  await page.getByLabel('I verified: The fixture file is implemented', { exact: true }).check();
  assert.equal(await button('Accept reviewed work').isEnabled(), true);
  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
  await button('Accept reviewed work').evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
  const contrast = await button('Accept reviewed work').evaluate(el => {
    const style = getComputedStyle(el);
    const luminance = color => { const values = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return .2126 * values[0] + .7152 * values[1] + .0722 * values[2]; };
    const a = luminance(style.color), b = luminance(style.backgroundColor); return (Math.max(a,b) + .05) / (Math.min(a,b) + .05);
  });
  assert.ok(contrast >= 4.5, `primary action contrast ${contrast}`);
  console.log(`Primary action text contrast: ${contrast.toFixed(2)}:1`);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await shot('review-desktop');
  for (const scale of [1, 2]) {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.evaluate(n => { document.documentElement.style.fontSize = `${16 * n}px`; }, scale);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal page overflow');
    await button('Accept reviewed work').scrollIntoViewIfNeeded();
    const actionBounds = await button('Accept reviewed work').boundingBox();
    assert.ok(actionBounds && actionBounds.width <= 320 && actionBounds.height >= 24, 'mobile review action remains reachable');
    await shot(`review-320-${scale}`);
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  await page.setViewportSize({ width: 768, height: 900 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.emulateMedia({ forcedColors: 'active' }); await shot('review-forced-colors');
  await page.emulateMedia({ forcedColors: 'none' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await activate(button('Accept reviewed work'));
  await page.getByRole('region', { name: 'Run workspace', exact: true }).getByText('Accepted, not merged', { exact: true }).first().waitFor();
  const href = page.url(); await page.reload(); await page.getByRole('region', { name: 'Run workspace', exact: true }).getByText('Accepted, not merged', { exact: true }).first().waitFor(); assert.equal(page.url(), href);
  await activate(page.getByRole('link', { name: 'All runs', exact: true }));
  await page.waitForURL(/#agents$/);
  await page.getByRole('region', { name: 'Run workspace', exact: true }).waitFor({ state: 'detached' });
  await page.locator('[aria-label="Agent runs"]').getByText('Verify connected delivery', { exact: true }).waitFor(); await shot('accepted-list');
  // Stop a genuinely active synthetic process, retaining its workspace and conversation.
  await activate(page.getByRole('link', { name: 'New assignment', exact: true }));
  await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Synthetic agent project' });
  await page.getByLabel('Outcome in one line', { exact: true }).fill('Stop and recover fixture');
  await page.getByLabel('Assignment', { exact: true }).fill('HANG');
  await page.getByLabel('What proves it is done (one criterion per line)', { exact: true }).fill('The recovered fixture change is inspected');
  await activate(button('Continue')); await activate(button('Continue'));
  assert.equal(await button('Queue assignment').isDisabled(), true);
  await page.getByLabel('I authorize this assignment and these checks to run locally using my agent account', { exact: true }).check();
  await activate(button('Queue assignment'));
  await page.getByRole('region', { name: 'Agent activity', exact: true }).filter({ hasText: 'Still working' }).waitFor();
  const active = (await currentRun()).run;
  assert.equal(active.status, 'running'); assert.ok(active.workspace); assert.ok(active.sessionId);
  await activate(button('Stop run (keep workspace)'));
  await page.getByRole('region', { name: 'Run workspace', exact: true }).getByText('Stopped', { exact: true }).waitFor();
  const stopped = (await currentRun()).run;
  assert.equal(stopped.workspace, active.workspace); assert.equal(stopped.sessionId, active.sessionId);
  await page.reload(); await button('Retry with this instruction').waitFor();
  assert.equal((await currentRun()).run.status, 'stopped');
  assert.equal(await button('Retry with this instruction').isDisabled(), true);
  await reply().fill('CHANGE'); await nextReview('Retry with this instruction', 'retry');
  const recovered = await currentRun();
  assert.equal(recovered.run.workspace, active.workspace); assert.equal(recovered.run.sessionId, active.sessionId);
  assert.equal(recovered.run.turn, active.turn + 1); assert.match(recovered.run.packet.diff, /implemented/);
  assert.equal(recovered.events.filter(event => event.text.includes('Existing session loaded.')).length, 1);
  await shot('stopped-recovered');

  // Interrupt the runtime itself; no SQL status patch and no real external agent.
  await reply().fill('HANG'); await perform('Reply / request changes', 'reply');
  await page.getByRole('region', { name: 'Run workspace', exact: true }).getByText('Working', { exact: true }).first().waitFor();
  await page.getByRole('tab', { name: 'Activity', exact: true }).click();
  await page.waitForFunction(async id => {
    const { run, events } = await (await fetch(`/api/agents/runs/${id}`)).json();
    return run.status === 'running' && events.filter(event => event.text.includes('Still working')).length === 2;
  }, active.id);
  const pid = Number(process.env.AGENT_UI_FIXTURE_PID);
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'Run with the isolated harness (AGENT_UI_FIXTURE_PID is required for restart coverage)');
  assert.equal((await read('/api/agents')).settings.paused, false);
  assert.equal(process.connected, true, 'The isolated harness supplies the fixture readiness channel');
  // A status read is not proof that the replacement HTTP listener is ready.
  // Subscribe before interrupting, then wait for the fixture's post-listen acknowledgement.
  await new Promise((resolve, reject) => {
    const ready = message => {
      if (message !== 'agent-fixture-restarted') return;
      clearTimeout(timer); process.off('message', ready); resolve();
    };
    const timer = setTimeout(() => { process.off('message', ready); reject(Error('Fixture restart readiness timeout')); }, 15000);
    process.on('message', ready); process.kill(pid, 'SIGUSR2');
  });
  assert.equal((await read(`/api/agents/runs/${active.id}`)).run.status, 'interrupted');
  assert.equal((await read('/api/agents')).settings.paused, true);
  await page.reload(); await page.getByLabel('I confirmed no previous agent is still working in this workspace', { exact: true }).waitFor();
  const interrupted = await currentRun();
  assert.equal(interrupted.run.workspace, active.workspace); assert.equal(interrupted.run.sessionId, active.sessionId);
  assert.equal(interrupted.run.packet, null);
  assert.ok(interrupted.history.some(packet => packet.id === recovered.history[0].id));
  await historical(recovered.history[0].id, recovered.run.packet);
  assert.equal(await button('Accept reviewed work').count(), 0);
  assert.equal((await read('/api/agents')).settings.paused, true);
  const recoveryURL = page.url(); await shot('interrupted-retained');
  // Resuming global starts alone must not restart a disconnected run.
  await activate(page.getByRole('link', { name: 'Execution settings', exact: true }));
  await activate(page.locator('summary').filter({ hasText: 'Execution paused' }));
  assert.equal(await page.getByLabel('Pause new starts (running work continues)', { exact: true }).isChecked(), true);
  await page.getByLabel('Pause new starts (running work continues)', { exact: true }).uncheck();
  await activate(button('Save execution settings')); await page.locator('summary').filter({ hasText: 'Execution enabled' }).waitFor();
  assert.equal((await read(`/api/agents/runs/${active.id}`)).run.status, 'interrupted');
  await page.goto(recoveryURL); await button('Retry with this instruction').waitFor();
  await reply().fill('CHANGE FOLLOWUP');
  assert.equal(await button('Retry with this instruction').isDisabled(), true);
  await page.getByLabel('I confirmed no previous agent is still working in this workspace', { exact: true }).check();
  await nextReview('Retry with this instruction', 'retry');
  const resumedData = await currentRun(), resumed = resumedData.run;
  assert.equal(resumedData.events.filter(event => event.text.includes('Existing session loaded.')).length, 3);
  assert.equal(resumed.workspace, active.workspace); assert.equal(resumed.sessionId, active.sessionId);
  assert.equal(resumed.turn, interrupted.run.turn + 1); assert.match(resumed.packet.diff, /revised/);
  assert.notEqual(resumed.packet.fingerprint, recovered.run.packet.fingerprint);
  await historical(recovered.history[0].id, recovered.run.packet);
  await reply().fill('Inspected the current revised fixture file after explicit interrupted recovery.');
  await page.getByLabel('I verified: The recovered fixture change is inspected', { exact: true }).check();
  assert.equal(await button('Accept reviewed work').isDisabled(), true);
  await page.getByLabel('No automated checks are configured; I performed and describe the manual verification below', { exact: true }).check();
  assert.equal(await button('Accept reviewed work').isEnabled(), true);
  await shot('recovered-manual-review');
  await activate(button('Accept reviewed work'));
  await page.getByRole('region', { name: 'Run workspace', exact: true }).getByText('Accepted, not merged', { exact: true }).first().waitFor();
  assert.equal((await currentRun()).run.status, 'accepted');
  await page.reload(); await page.getByRole('region', { name: 'Run workspace', exact: true }).getByText('Accepted, not merged', { exact: true }).first().waitFor();
  assert.ok((await currentRun()).history.some(packet => packet.id === recovered.history[0].id));
  assert.deepEqual(errors, []); console.log('Agent UI walkthrough passed: consent, retry-preserved draft, permission, check, exact review, persistence, keyboard activation, 320px/200% reflow, retained/current/failed evidence gates, stop/retry, real fixture-runtime interruption/restart and explicit recovery/manual acceptance.');
} catch(e) {
  console.error(e);
  try { await shot('failure'); } catch(captureError) { console.error('Failure screenshot unavailable:', captureError); }
  throw e;
} finally { await browser.close(); if (process.connected) process.disconnect(); }
