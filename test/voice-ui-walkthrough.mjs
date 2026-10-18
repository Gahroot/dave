// Talk to DAVE walkthrough. Run after npm run build and test/voice-ui-fixture.ts (synthetic port 4327 only).
// WebRTC is replaced in the page by a fake peer whose "oai-events" channel this script drives with scripted Realtime
// events, and https://api.openai.com/v1/realtime/calls is a routed stub: no audio or request ever leaves the machine.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

const BASE = 'http://127.0.0.1:4327';
const CALLS = 'https://api.openai.com/v1/realtime/calls';
const SECRET = 'ek_synthetic_fixture_secret';
const SENTINEL = 'SYNTHETIC_CHATGPT_TOKEN_SENTINEL';
const out = '.ezcoder/screenshots/voice'; fs.mkdirSync(out, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dave-voice-walk-'));

// Synthetic documents drawn locally with AppKit (macOS), the same way test/documents-mac.test.ts makes its fixtures.
const MAKE = `ObjC.import('AppKit'); ObjC.import('PDFKit');
function run(argv) {
  const out = argv[0], kind = argv[1], texts = argv.slice(2);
  if (kind === 'pdf') {
    const doc = $.PDFDocument.alloc.init;
    texts.forEach((t, i) => {
      const v = $.NSTextView.alloc.initWithFrame($.NSMakeRect(0, 0, 612, 792));
      v.string = $(t); v.font = $.NSFont.systemFontOfSize(18);
      doc.insertPageAtIndex($.PDFDocument.alloc.initWithData(v.dataWithPDFInsideRect(v.bounds)).pageAtIndex(0), i);
    });
    return doc.writeToFile($(out)) ? 'ok' : 'fail';
  }
  const img = $.NSImage.alloc.initWithSize($.NSMakeSize(900, 200));
  img.lockFocus;
  $.NSColor.whiteColor.setFill; $.NSRectFill($.NSMakeRect(0, 0, 900, 200));
  $(texts[0]).drawAtPointWithAttributes($.NSMakePoint(20, 80), $.NSDictionary.dictionaryWithObjectForKey($.NSFont.systemFontOfSize(40), $.NSFontAttributeName));
  img.unlockFocus;
  const png = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation).representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  return png.writeToFileAtomically($(out), true) ? 'ok' : 'fail';
}`;
const pdfPath = path.join(work, 'acme-statement-of-work.pdf'), pngPath = path.join(work, 'acme-invoice.png');
execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAKE, pdfPath, 'pdf', 'Statement of Work: Acme Clinic Portal', 'Payment is due when the clinic signs off online booking']);
execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAKE, pngPath, 'png', 'Invoice total 4200 dollars']);

/** Installed before any page script: fake mic stream, fake peer and a scriptable data channel at window.__rt. */
function fakeRealtime() {
  const rt = { sent: [], channel: null, offers: 0 };
  window.__rt = rt;
  rt.emit = (event) => rt.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }));
  const tone = (frequency) => { const ctx = new AudioContext(); const osc = ctx.createOscillator(); const dest = ctx.createMediaStreamDestination(); osc.frequency.value = frequency; osc.connect(dest); osc.start(); return dest.stream; };
  navigator.mediaDevices.getUserMedia = async () => tone(220);
  class FakeChannel extends EventTarget {
    constructor(label) { super(); this.label = label; this.readyState = 'connecting'; }
    send(data) { rt.sent.push(JSON.parse(data)); }
    close() { this.readyState = 'closed'; }
  }
  class FakePeer {
    constructor() { this.ontrack = null; this.senders = []; this.channel = null; }
    addTrack(track) { this.senders.push({ track }); }
    getSenders() { return this.senders; }
    createDataChannel(label) { this.channel = new FakeChannel(label); rt.channel = this.channel; return this.channel; }
    async createOffer() { rt.offers++; rt.audioLineFirst = this.senders.length > 0; return { type: 'offer', sdp: 'v=0\r\nsynthetic-offer\r\n' }; }
    async setLocalDescription() {}
    async setRemoteDescription(answer) {
      rt.answer = answer.sdp;
      const stream = tone(330);
      setTimeout(() => {
        this.ontrack?.({ streams: [stream], track: stream.getAudioTracks()[0] });
        this.channel.readyState = 'open'; this.channel.dispatchEvent(new Event('open'));
      }, 50);
    }
    close() { if (this.channel) this.channel.readyState = 'closed'; }
  }
  window.RTCPeerConnection = FakePeer;
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { window.syntheticClipboard = text; } } });
}

const lum = rgb => rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
const contrast = (a, b) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);

const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE });
const problems = [], callsSeen = [], bodies = [];
let lastPage = null;
async function newPage(width, height) {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addInitScript(fakeRealtime);
  await context.route('https://api.openai.com/**', async (route) => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': BASE, 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'POST' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    callsSeen.push({ url: req.url(), auth: req.headers()['authorization'], type: req.headers()['content-type'], body: req.postData() });
    if (req.url() !== CALLS || req.method() !== 'POST') return route.abort();
    return route.fulfill({ status: 201, headers: { ...cors, 'content-type': 'application/sdp' }, body: 'v=0\r\nsynthetic-answer\r\n' });
  });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  lastPage = page;
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('request', r => { const u = r.url(); if (!u.startsWith(`${BASE}/`) && !u.startsWith(CALLS) && !u.startsWith('data:') && !u.startsWith('blob:')) problems.push(`unexpected request ${u}`); });
  page.on('response', async r => { if (r.url().startsWith(`${BASE}/api/`)) bodies.push(await r.text().catch(() => '')); });
  return { context, page };
}
const shot = (page, name) => page.screenshot({ path: `${out}/${name}.png`, animations: 'disabled' });
const sent = (page) => page.evaluate(() => window.__rt.sent);
const emit = (page, ...events) => page.evaluate((list) => { for (const e of list) window.__rt.emit(e); }, events);
const waitSent = (page, predicate, arg) => page.waitForFunction(([src, a]) => window.__rt?.sent.some(e => new Function('e', 'a', `return (${src})(e, a)`)(e, a)), [predicate.toString(), arg]);
const api = (page, url) => page.evaluate(u => fetch(u).then(r => r.json()), url);
/** Guarded POST from the page itself (same origin, with the CSRF token), returning status and JSON. */
const post = (page, url, body) => page.evaluate(async ([u, b]) => {
  const token = (await (await fetch('/api/security/csrf')).json()).token;
  const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dave-csrf': token }, body: JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [url, body]);
const outputOf = async (page, callId) => JSON.parse((await sent(page)).find(e => e.item?.type === 'function_call_output' && e.item.call_id === callId).item.output);
const waitOutput = (page, callId) => waitSent(page, (e, a) => e.item?.type === 'function_call_output' && e.item.call_id === a, callId);
const systemNote = (page, prefix) => waitSent(page, (e, a) => e.item?.role === 'system' && e.item.content?.[0]?.text?.startsWith(a), prefix);

/** Interactive targets on the dark stage: named, at least 44 px, readable text. */
async function auditStage(page, label) {
  const report = await page.evaluate(() => {
    const stage = document.querySelector('[data-voice-panel]');
    const small = [], unnamed = [];
    for (const el of stage.querySelectorAll('button, select, input:not([type=file]):not([type=checkbox]), a[href]')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const name = el.getAttribute('aria-label') || el.textContent.trim() || el.labels?.[0]?.textContent.trim();
      if (!name) unnamed.push(el.outerHTML.slice(0, 80));
      if (r.width < 44 || r.height < 44) small.push(`${name} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    const bg = getComputedStyle(stage).backgroundColor;
    const colours = [...stage.querySelectorAll('.voice-detail, .voice-disclosure, .voice-line, .voice-chip, .voice-who, .voice-empty, .voice-card p, .voice-card strong, .voice-title')]
      .filter(el => el.getBoundingClientRect().width).map(el => [el.className, getComputedStyle(el).color, getComputedStyle(el.closest('.voice-card') ?? stage).backgroundColor]);
    return { small, unnamed, bg, colours };
  });
  for (const [cls, fg, bg] of report.colours) {
    const solidBg = /rgba\(.*,\s*0(\.\d+)?\)$/.test(bg) && !bg.endsWith(', 1)') ? report.bg : bg;
    const ratio = contrast(fg, solidBg);
    if (ratio < 4.5) problems.push(`${label}: low contrast ${ratio.toFixed(2)} for .${cls.split(' ').join('.')} (${fg} on ${solidBg})`);
  }
  if (report.small.length) problems.push(`${label}: targets under 44px: ${report.small.join('; ')}`);
  if (report.unnamed.length) problems.push(`${label}: unnamed controls: ${report.unnamed.join('; ')}`);
}

/** Approve all: a question is refused, the card button approves and runs the open card, writes then apply at once,
 * Undo restores, Turn off asks again, a spoken grant whose transcript lands late works, and approval ends with the
 * session. Also captures 3D DAVE (hero, mid-spin, dock). Leaves the meeting noise as it found it. */
async function approveAllWalkthrough(beta) {
  const va = await newPage(1440, 900);
  const vp = va.page;
  await vp.goto(`${BASE}/#focus`);
  const preview = async () => (await post(vp, '/api/triage/preview', {})).body;
  assert.equal((await preview()).counts.overdue_promises, 3, 'fixture noise present');
  const vdock = vp.getByRole('button', { name: 'Talk to DAVE (Alt+Shift+D)', exact: true });
  await vdock.click();
  const vdrawer = vp.getByRole('dialog', { name: 'Talk to DAVE' });
  await vdrawer.waitFor();
  await vdrawer.getByText('Approve all for this session', { exact: true }).waitFor();
  await vp.waitForTimeout(600);
  await vdrawer.locator('.voice-hero').screenshot({ path: `${out}/dave-hero-180.png` });
  const vstarted = vp.waitForResponse(r => r.url() === `${BASE}/api/voice/sessions` && r.request().method() === 'POST');
  await vdrawer.getByRole('button', { name: 'Talk', exact: true }).click();
  const sessionId = (await (await vstarted).json()).sessionId;
  await waitSent(vp, e => e.type === 'session.update');
  await emit(vp, { type: 'session.created' }, { type: 'session.updated', session: {} });
  await waitSent(vp, e => e.type === 'response.create');
  await vdrawer.getByRole('button', { name: 'End', exact: true }).waitFor();
  const say = async (words) => emit(vp, { type: 'input_audio_buffer.speech_started' }, { type: 'input_audio_buffer.speech_stopped' },
    { type: 'conversation.item.input_audio_transcription.completed', transcript: words });
  const creates = async () => (await sent(vp)).filter(e => e.type === 'response.create').length;
  /** Play a short reply for every response.create the app has sent and not yet seen answered, so queued notes flush. */
  let answered = 0;
  const drain = async () => {
    const n = await creates();
    for (; answered < n; answered++) await emit(vp, { type: 'response.created', response: {} }, { type: 'response.done', response: { output: [] } });
  };
  await drain();
  /** End the function-call response, wait for the follow-up the app asks for, and answer it. */
  const finishTurn = async (callId) => {
    await waitOutput(vp, callId);
    await emit(vp, { type: 'response.done', response: { output: [] } });
    await vp.waitForFunction(n => window.__rt.sent.filter(e => e.type === 'response.create').length > n, answered);
    await drain();
    return outputOf(vp, callId);
  };
  const callTool = async (callId, name, args) => {
    await emit(vp, { type: 'response.created', response: {} }, { type: 'response.function_call_arguments.done', call_id: callId, name, arguments: JSON.stringify(args) });
    return finishTurn(callId);
  };
  // A question is not a grant: refused, and the panel offers the button instead.
  await say('Did the client approve the mockups?');
  const refused = await callTool('call_appr_q', 'approve_session', { on: true });
  assert.equal(refused.approved, false, JSON.stringify(refused));
  await vdrawer.getByText('Approve all for this session?', { exact: true }).waitFor();
  assert.equal(await vdrawer.locator('.voice-approval-banner').count(), 0);
  // find_noise counts; clean_up prepares exactly the matching items.
  const found = await callTool('call_noise', 'find_noise', {});
  assert.equal(found.total, (await preview()).total, JSON.stringify(found));
  const prepared = await callTool('call_clean', 'clean_up', { buckets: ['overdue_promises'] });
  assert.equal(prepared.needsConfirmation, true, JSON.stringify(prepared));
  const cleanCard = vdrawer.locator('.voice-card').filter({ hasText: 'Clear 3 items' }).first();
  await cleanCard.getByRole('button', { name: 'Confirm', exact: true }).waitFor();
  await cleanCard.getByText('Send Acme the revised booking mockups (Acme Clinic Portal)').waitFor();
  assert.equal((await preview()).counts.overdue_promises, 3, 'nothing cleared before the click');
  await cleanCard.scrollIntoViewIfNeeded();
  await shot(vp, 'voice-cleanup-confirm-1440');
  await auditStage(vp, 'clean-up confirm card 1440');
  // The card's Approve all: turns approval on and confirms this open card.
  await cleanCard.getByRole('button', { name: 'Approve all for this session (confirms this and every later change)', exact: true }).click();
  await vdrawer.locator('.voice-approval-banner').getByRole('button', { name: 'Turn off Approve all', exact: true }).waitFor();
  await systemNote(vp, '[Update] The user turned on Approve all for this session.');
  const undoButton = vdrawer.getByRole('button', { name: 'Undo: Clear 3 items', exact: true });
  await undoButton.waitFor();
  assert.equal((await preview()).counts.overdue_promises, 0, 'the open clean-up card ran');
  // The stage's chips follow the change at once (not on the next poll).
  const decisions = (await api(vp, `${BASE}/api/intel/focus`)).decisions.length;
  await vdrawer.getByText(`${decisions} decision${decisions === 1 ? '' : 's'} waiting`, { exact: true }).waitFor({ timeout: 3000 });
  await vp.waitForTimeout(200);
  await drain();
  // While on, a write applies at once: no token, a green card.
  const auto = await callTool('call_paid_auto', 'set_paid_when', { project: 'Beta', paidWhen: 'the bakery takes its first online order' });
  assert.equal(auto.autoApproved, true, JSON.stringify(auto));
  assert.equal(auto.confirmToken, undefined);
  assert.equal((await api(vp, `${BASE}/api/intel/projects/${beta}`)).direction.paidWhen, 'the bakery takes its first online order');
  await vdrawer.locator('.voice-card').filter({ hasText: 'Approved for this session' }).first().waitFor();
  await vdrawer.locator('.voice-approval-banner').scrollIntoViewIfNeeded();
  await shot(vp, 'voice-approve-all-on-1440');
  await auditStage(vp, 'approve all on 1440');
  // Undo from the card restores the cleared promises.
  await undoButton.click();
  await vdrawer.getByText('Undone. The items are back.', { exact: true }).waitFor();
  await vp.waitForTimeout(200);
  await drain();
  assert.equal((await preview()).counts.overdue_promises, 3);
  // The dock shows approval while the drawer is closed.
  await vp.keyboard.press('Escape');
  await vdrawer.waitFor({ state: 'detached' });
  const liveDock = vp.getByRole('button', { name: /Approve all is on$/ });
  await liveDock.getByText('Approve all on', { exact: true }).waitFor();
  await vp.screenshot({ path: `${out}/dock-approve-on.png`, clip: await (async () => { const b = await liveDock.boundingBox(); return { x: b.x - 160, y: b.y - 40, width: b.width + 180, height: b.height + 60 }; })() });
  await liveDock.click();
  await vdrawer.waitFor();
  // Turn off: writes need a confirmation again.
  await vdrawer.getByRole('button', { name: 'Turn off Approve all', exact: true }).click();
  await vdrawer.locator('.voice-approval-banner').waitFor({ state: 'detached' });
  await systemNote(vp, '[Update] The user turned off Approve all');
  await drain();
  const asked = await callTool('call_paid_ask', 'set_paid_when', { project: 'Beta', paidWhen: 'the owner signs off the catalogue' });
  assert.equal(asked.needsConfirmation, true, JSON.stringify(asked));
  await vdrawer.locator('.voice-card').filter({ hasText: 'Paid when for Beta Bakery Ordering' }).last().getByRole('button', { name: 'Not that', exact: true }).click();
  await vp.waitForTimeout(200);
  await drain();
  // A spoken grant whose transcript arrives after the function call: the browser waits for it, then attaches it.
  await emit(vp, { type: 'input_audio_buffer.speech_started' }, { type: 'input_audio_buffer.speech_stopped' },
    { type: 'response.created', response: {} }, { type: 'response.function_call_arguments.done', call_id: 'call_appr_voice', name: 'approve_session', arguments: JSON.stringify({ on: true }) });
  await vp.waitForTimeout(400);
  assert.equal((await sent(vp)).some(e => e.item?.call_id === 'call_appr_voice'), false, 'held until the transcript lands');
  await emit(vp, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'You have my approval, just do it.' });
  const granted = await finishTurn('call_appr_voice');
  assert.deepEqual([granted.done, granted.approval], [true, true], JSON.stringify(granted));
  await vdrawer.locator('.voice-approval-banner').waitFor();
  assert.ok((await sent(vp)).every(e => !JSON.stringify(e).includes('Synthetic quote')), 'no meeting quote reached the model');
  // Spin DAVE: drag across the hero and capture the turned head mid-drag.
  const hero = vdrawer.locator('.voice-hero');
  await hero.scrollIntoViewIfNeeded();
  const hb = await hero.boundingBox();
  await vp.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await vp.mouse.down();
  for (let i = 1; i <= 6; i++) await vp.mouse.move(hb.x + hb.width / 2 + i * 12, hb.y + hb.height / 2);
  await vp.waitForTimeout(120);
  await hero.screenshot({ path: `${out}/dave-spin-180.png` });
  await vp.mouse.up();
  // End: approval dies with the session.
  await vdrawer.getByRole('button', { name: 'End', exact: true }).click();
  await vdrawer.getByText('Conversation saved. Talk again any time.', { exact: true }).waitFor();
  assert.equal(await vdrawer.locator('.voice-approval-banner').count(), 0);
  // Outside the page (an expected 404 must not show up as a console error).
  const token = await vp.evaluate(async () => (await (await fetch('/api/security/csrf')).json()).token);
  const late = await vp.request.post(`${BASE}/api/voice/sessions/${sessionId}/approval`, { headers: { origin: BASE, 'x-dave-csrf': token }, data: { on: true } });
  assert.equal(late.status(), 404, 'no approval for an ended session');
  // Keyboard focus stays in the drawer after End (the End button turns into a briefly disabled Talk button).
  await vp.waitForFunction(() => !!document.activeElement?.closest('[data-voice-panel]'));
  await vp.keyboard.press('Escape');
  await vdrawer.waitFor({ state: 'detached' });
  await vdock.screenshot({ path: `${out}/dave-dock-64.png` });
  await va.context.close();
}

/** Clean up page: nav count, the Focus link into the overdue bucket, Clear everywhere at once, Undo puts it all
 * back; a phone-width pass; then clear every noisy item (including the one you confirmed, chosen explicitly). */
async function cleanUpWalkthrough({ acme, gamma, beta }) {
  const cu = await newPage(1440, 900);
  const cp = cu.page;
  await cp.goto(`${BASE}/#focus`);
  const preview = async () => { const r = await post(cp, '/api/triage/preview', {}); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
  const inboxPromises = async () => (await api(cp, `${BASE}/api/portfolio`)).inbox.filter(i => i.kind === 'meeting-promise').length;
  const meetingPromises = async () => (await api(cp, `${BASE}/api/meetings/items`)).promises.length;
  const openCommitments = async () => {
    let n = 0;
    for (const p of [acme, gamma, beta]) n += (await api(cp, `${BASE}/api/intel/projects/${p}`)).items.filter(i => i.kind === 'commitment' && ['open', 'in_progress'].includes(i.status)).length;
    return n;
  };
  const noise = await preview();
  assert.deepEqual([noise.counts.overdue_promises, noise.counts.stale_promises, noise.counts.looks_done, noise.counts.old_asks], [3, 2, 1, 1], JSON.stringify(noise.counts));
  assert.equal(noise.confirmedHidden, 1, 'the promise you set yourself is hidden by default');
  assert.ok(noise.entries.every(e => !e.title.includes('double-booking') && !JSON.stringify(e).includes('Synthetic quote')), 'no confirmed rows and no meeting quotes');
  const base = { inbox: await inboxPromises(), meetings: await meetingPromises(), commitments: await openCommitments() };
  console.log('Clean up baseline', JSON.stringify({ counts: noise.counts, total: noise.total, ...base }));
  const navCount = (n) => cp.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: new RegExp(`^Clean up\\s*, ${n} items? to clean up$`) });
  await navCount(noise.total).waitFor();
  await shot(cp, 'focus-with-noise-1440');
  await cp.getByRole('link', { name: 'Clean up overdue promises', exact: true }).click();
  await cp.waitForURL(/#cleanup\?bucket=overdue_promises$/);
  const overdueHead = cp.getByRole('heading', { name: 'Overdue promises', level: 2 });
  await overdueHead.waitFor();
  await cp.waitForFunction(() => document.activeElement?.id === 'cleanup-overdue_promises');
  await cp.getByText(new RegExp(`^DAVE found ${noise.total} items that look like noise: 3 overdue promises nobody confirmed`)).waitFor();
  const checkedRows = () => cp.locator('.cleanup-row input[type=checkbox]:checked').count();
  assert.equal(await checkedRows(), 3, 'only the linked bucket starts selected');
  assert.equal(await cp.locator('section.cleanup-bucket').filter({ has: overdueHead }).locator('.cleanup-row input[type=checkbox]:checked').count(), 3);
  await cp.getByRole('checkbox', { name: 'Select all (3) in Overdue promises', exact: true }).waitFor();
  // A promise you set yourself shows only on request, tagged and never preselected.
  const includeConfirmed = cp.getByRole('switch', { name: 'Include ones you confirmed' });
  await includeConfirmed.click();
  const confirmedRow = cp.locator('.cleanup-row').filter({ hasText: 'Fix the double-booking bug before launch' });
  await confirmedRow.getByText('You confirmed this', { exact: true }).waitFor();
  assert.equal(await confirmedRow.locator('input[type=checkbox]').isChecked(), false, 'confirmed rows are never preselected');
  await includeConfirmed.click();
  await confirmedRow.waitFor({ state: 'detached' });
  assert.equal(await checkedRows(), 3, 'the selection survives the filter round trip');
  await shot(cp, 'cleanup-1440');
  await cp.screenshot({ path: `${out}/cleanup-full-1440.png`, fullPage: true, animations: 'disabled' });
  await cp.getByRole('button', { name: 'Clear 3 selected', exact: true }).click();
  await cp.locator('.cleanup-outcome').getByText('Cleared 3 items.').waitFor();
  await overdueHead.waitFor({ state: 'detached' });
  const cleared = await preview();
  assert.equal(cleared.counts.overdue_promises, 0);
  assert.equal(cleared.total, noise.total - 3);
  const after = { inbox: await inboxPromises(), meetings: await meetingPromises(), commitments: await openCommitments() };
  console.log('Clean up after clear', JSON.stringify(after));
  assert.equal(after.meetings, base.meetings - 3, 'gone from Meetings');
  assert.ok(after.inbox < base.inbox || base.inbox === 0, 'gone from the Inbox');
  assert.ok(after.commitments <= base.commitments - 3, 'linked plan commitments closed too');
  await navCount(noise.total - 3).waitFor();
  await cp.getByRole('heading', { name: 'Recent clean-ups' }).scrollIntoViewIfNeeded();
  await shot(cp, 'cleanup-cleared-1440');
  await cp.locator('.cleanup-outcome').getByRole('button', { name: 'Undo', exact: true }).click();
  await cp.locator('.cleanup-outcome').getByText(/^Restored \d+ items\.$/).waitFor();
  await overdueHead.waitFor();
  assert.equal((await preview()).counts.overdue_promises, 3, 'Undo brings the promises back');
  assert.deepEqual({ inbox: await inboxPromises(), meetings: await meetingPromises(), commitments: await openCommitments() }, base, 'Undo restores Meetings, the Inbox and the plan');
  await cp.locator('.cleanup-batch').first().getByText('Undone', { exact: true }).waitFor();
  await shot(cp, 'cleanup-undone-1440');
  await cp.goto(`${BASE}/#meetings`);
  await cp.getByRole('link', { name: 'Clean up in bulk', exact: true }).waitFor();

  // Phone width: filters stack, no sideways scrolling.
  const phone = await newPage(390, 844);
  await phone.page.goto(`${BASE}/#cleanup?bucket=stale_promises`);
  await phone.page.getByRole('heading', { name: 'Old promises with no date', level: 2 }).waitFor();
  assert.ok(await phone.page.evaluate(() => document.documentElement.scrollWidth <= 390), 'Clean up fits 390 px without sideways scrolling');
  await shot(phone.page, 'cleanup-390');
  await phone.page.screenshot({ path: `${out}/cleanup-full-390.png`, fullPage: true, animations: 'disabled' });
  await phone.context.close();

  // Clear everything, including the promise you confirmed (chosen explicitly), and see the empty state.
  await cp.goto(`${BASE}/#cleanup`);
  await cp.getByRole('heading', { name: 'Overdue promises', level: 2 }).waitFor();
  await includeConfirmed.click();
  await confirmedRow.waitFor();
  for (const box of await cp.locator('.cleanup-select-all input[type=checkbox]').all()) if (!(await box.isChecked())) await box.click();
  const all = (await preview()).total + 1;
  await cp.getByRole('button', { name: `Clear ${all} selected`, exact: true }).click();
  await cp.locator('.cleanup-outcome').getByText(`Cleared ${all} items.`).waitFor();
  await cp.getByText('Nothing looks like noise right now.').first().waitFor();
  await shot(cp, 'cleanup-empty-1440');
  assert.equal((await post(cp, '/api/triage/preview', { filter: { includeConfirmed: true } })).body.total, 0);
  await cu.context.close();
}

try {
  const { context, page } = await newPage(1440, 900);
  await page.goto(`${BASE}/#focus`);
  const state = await api(page, `${BASE}/api/intel/focus`);
  const id = name => state.projects.find(p => p.projectName === name).projectId;
  const acme = id('Acme Clinic Portal'), gamma = id('Gamma Freight Dashboard'), beta = id('Beta Bakery Ordering');
  // 0. Meeting noise first: Approve all by voice, then the Clean up page, which ends by clearing every noisy item so
  // the direction steps below run on a portfolio with no overdue meeting promises.
  await approveAllWalkthrough(beta);
  await cleanUpWalkthrough({ acme, gamma, beta });
  await page.reload();
  const clean = await api(page, `${BASE}/api/intel/focus`);
  assert.notEqual(clean.top.projectId, gamma, 'baseline: Gamma is not the top objective yet');

  // 1. The dock sits on the light Focus page.
  const dock = page.getByRole('button', { name: 'Talk to DAVE (Alt+Shift+D)', exact: true });
  await dock.waitFor();
  const box = await dock.boundingBox();
  assert.ok(box.width >= 64 && box.height >= 64 && box.x + box.width > 1300 && box.y + box.height > 800, `dock bottom-right ${JSON.stringify(box)}`);
  await shot(page, 'focus-dock-1440');

  // 2. Direction panel: paid when, priority #1, a focus item and a note on Gamma.
  await page.goto(`${BASE}/#focus?project=${gamma}`);
  const panel = page.locator('.direction-panel');
  await panel.getByRole('heading', { name: 'Your direction' }).waitFor();
  await panel.getByRole('button', { name: 'Set', exact: true }).click();
  await panel.getByLabel('Paid when', { exact: true }).fill('the dispatcher signs off the live map');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await panel.getByText('the dispatcher signs off the live map', { exact: true }).waitFor();
  await panel.getByLabel('Priority', { exact: true }).selectOption('1');
  await page.waitForFunction(() => { const s = document.querySelector('.direction-priority select'); return s && s.value === '1' && !s.disabled; });
  await panel.getByLabel('Add a finish-line item', { exact: true }).selectOption({ label: 'Customer ETA page' });
  await panel.getByRole('button', { name: 'Add', exact: true }).click();
  await panel.getByRole('button', { name: 'Remove "Customer ETA page" from matters most now', exact: true }).waitFor();
  await panel.getByLabel('Add a note', { exact: true }).fill('Gamma pays the next invoice once dispatch uses the ETA page.');
  await panel.getByRole('button', { name: 'Save note', exact: true }).click();
  await panel.getByText('Gamma pays the next invoice once dispatch uses the ETA page.', { exact: true }).waitFor();
  const effect = panel.getByLabel('How your direction changes the ranking', { exact: true });
  await effect.getByText('You said this matters most now · +60').waitFor();
  await effect.getByText('Your project priority · +45').waitFor();
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: `${out}/direction-panel-1440.png`, animations: 'disabled' });
  const after = await api(page, `${BASE}/api/intel/focus`);
  assert.equal(after.top.projectId, gamma, 'your direction makes Gamma the top objective');
  assert.deepEqual(after.top.scoreReasons.filter(r => r.code.startsWith('owner_')).map(r => [r.code, r.points]), [['owner_focus', 60], ['owner_priority', 45]]);
  await page.goto(`${BASE}/#focus`);
  const gammaRow = page.locator('.project-order-row').filter({ hasText: 'Gamma Freight Dashboard' });
  await gammaRow.getByText('Paid when the dispatcher signs off the live map', { exact: true }).waitFor();
  await gammaRow.getByText('Priority 1', { exact: true }).waitFor();
  await shot(page, 'focus-direction-1440');

  // 3. Open the drawer with the shortcut; Escape closes it and focus comes back.
  await dock.focus();
  await page.keyboard.press('Alt+Shift+KeyD');
  const drawer = page.getByRole('dialog', { name: 'Talk to DAVE' });
  await drawer.waitFor();
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[data-voice-panel]')), true, 'focus moves into the drawer');
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement?.classList.contains('voice-dock'));
  await dock.click();
  await drawer.waitFor();
  await drawer.getByText(/conversation, DAVE's tool results and any document DAVE reads/).waitFor();
  await shot(page, 'panel-idle-1440');
  await auditStage(page, 'idle drawer 1440');

  // 4. Start: server mints the ephemeral secret, the SDP goes to the stub, session.update goes out on open.
  const started = page.waitForResponse(r => r.url() === `${BASE}/api/voice/sessions` && r.request().method() === 'POST');
  await drawer.getByRole('button', { name: 'Talk', exact: true }).click();
  const startBody = await (await started).json();
  assert.equal(startBody.secret, SECRET); assert.equal(startBody.model, 'gpt-realtime-2.1'); assert.equal(startBody.voice, 'marin');
  await waitSent(page, e => e.type === 'session.update');
  const call = callsSeen.at(-1);
  assert.deepEqual([call.url, call.auth, call.type], [CALLS, `Bearer ${SECRET}`, 'application/sdp'], 'SDP posted to /v1/realtime/calls with the ephemeral secret and no model parameter');
  assert.equal(await page.evaluate(() => window.__rt.audioLineFirst), true, 'mic track added before the offer');
  const update = (await sent(page)).find(e => e.type === 'session.update');
  assert.equal(update.session.type, 'realtime');
  assert.ok(update.session.tools.length > 20 && update.session.tools.every(t => !['launch_agent', 'connect_openai', 'disconnect_openai', 'hide_project', 'fathom_key'].includes(t.name)));
  assert.deepEqual(['approve_session', 'find_noise', 'clean_up', 'undo_clean_up'].filter(n => update.session.tools.some(t => t.name === n)), ['approve_session', 'find_noise', 'clean_up', 'undo_clean_up'], 'clean-up and approval tools offered');
  assert.ok(!JSON.stringify(update).includes(SENTINEL));
  await emit(page, { type: 'session.created' }, { type: 'session.updated', session: {} });
  await waitSent(page, e => e.type === 'response.create');
  await drawer.getByRole('button', { name: 'End', exact: true }).waitFor();
  // Live: the stage polls the focus queue and shows what DAVE sees.
  await drawer.getByText('1 without a finish line', { exact: true }).waitFor();

  // 5. DAVE greets (speaking), then the user asks for a change: a scripted set_paid_when call.
  await emit(page, { type: 'response.created', response: {} }, { type: 'output_audio_buffer.started' },
    { type: 'response.output_audio_transcript.delta', delta: 'Hi, I am DAVE. Beta Bakery has no finish line yet.' });
  await page.waitForTimeout(400);
  await shot(page, 'panel-speaking-1440');
  await emit(page, { type: 'response.output_audio_transcript.done', transcript: 'Hi, I am DAVE. Beta Bakery has no finish line yet. Want to set it?' },
    { type: 'output_audio_buffer.stopped' }, { type: 'response.done', response: { output: [] } },
    { type: 'input_audio_buffer.speech_started' }, { type: 'conversation.item.input_audio_transcription.delta', delta: 'Acme gets paid when' });
  await drawer.getByText('Acme gets paid when').waitFor();
  await emit(page, { type: 'input_audio_buffer.speech_stopped' },
    { type: 'conversation.item.input_audio_transcription.completed', transcript: 'Acme gets paid when the clinic signs off online booking.' });
  const args = JSON.stringify({ project: 'Acme', paidWhen: 'the clinic signs off online booking' });
  const before = (await sent(page)).length;
  await emit(page, { type: 'response.created', response: {} }, { type: 'response.function_call_arguments.done', call_id: 'call_paid', name: 'set_paid_when', arguments: args });
  const confirmCard = drawer.locator('.voice-card').filter({ hasText: 'Paid when for Acme Clinic Portal' });
  await confirmCard.getByRole('button', { name: 'Confirm', exact: true }).waitFor();
  await waitSent(page, e => e.item?.type === 'function_call_output' && e.item.call_id === 'call_paid');
  // The same call again inside response.done is not forwarded twice; exactly one response.create follows the output.
  await emit(page, { type: 'response.done', response: { output: [{ type: 'function_call', call_id: 'call_paid', name: 'set_paid_when', arguments: args }] } });
  await page.waitForTimeout(300);
  const afterCall = (await sent(page)).slice(before);
  assert.equal(afterCall.filter(e => e.item?.type === 'function_call_output').length, 1, 'one output per call id');
  assert.equal(afterCall.filter(e => e.type === 'response.create').length, 1, 'one response.create after the output');
  const output = JSON.parse(afterCall.find(e => e.item?.type === 'function_call_output').item.output);
  assert.equal(output.needsConfirmation, true, 'the write only prepared');
  assert.equal((await api(page, `${BASE}/api/intel/projects/${acme}`)).direction.paidWhen, null, 'nothing saved before confirmation');
  await emit(page, { type: 'response.created', response: {} },
    { type: 'response.output_audio_transcript.done', transcript: 'Acme gets paid when the clinic signs off online booking. Okay?' }, { type: 'response.done', response: { output: [] } });
  await confirmCard.scrollIntoViewIfNeeded();
  await shot(page, 'panel-confirm-1440');
  await auditStage(page, 'confirm card 1440');
  await confirmCard.getByRole('button', { name: 'Confirm', exact: true }).click();
  await confirmCard.getByText('Done.', { exact: true }).waitFor();
  await drawer.locator('.voice-card').filter({ hasText: 'Paid when saved' }).waitFor();
  assert.equal((await api(page, `${BASE}/api/intel/projects/${acme}`)).direction.paidWhen, 'the clinic signs off online booking');
  await waitSent(page, e => e.item?.role === 'system' && e.item.content?.[0]?.text?.startsWith('[Update] The user confirmed "Paid when for Acme Clinic Portal" on screen and it is done.'));
  await emit(page, { type: 'response.created', response: {} }, { type: 'response.done', response: { output: [] } });

  // 6. Page context: moving to a project tells DAVE and shows the chip.
  await page.evaluate(h => { window.location.hash = h; }, `#focus?project=${acme}`);
  await drawer.getByText('Looking at: Acme Clinic Portal', { exact: true }).waitFor();
  await waitSent(page, e => e.item?.role === 'system' && e.item.content?.[0]?.text?.startsWith('[Context]'));

  // 7. Share a PDF and a PNG: uploaded, read locally, announced; the small image goes in as input_image.
  await drawer.locator('input[type=file]').setInputFiles([pdfPath, pngPath]);
  const pdfCard = drawer.locator('.voice-doc').filter({ hasText: 'acme-statement-of-work.pdf' });
  const pngCard = drawer.locator('.voice-doc').filter({ hasText: 'acme-invoice.png' });
  await pdfCard.getByText('PDF · 2 pages · text read', { exact: true }).waitFor({ timeout: 30000 });
  await pngCard.getByText('IMAGE · text read · image sent', { exact: true }).waitFor({ timeout: 30000 });
  await pngCard.locator('img.voice-thumb').waitFor();
  await waitSent(page, e => e.item?.content?.[0]?.type === 'input_image' && e.item.content[0].image_url.startsWith('data:image/jpeg'));
  await waitSent(page, e => e.item?.role === 'system' && e.item.content?.[0]?.text?.includes('[Shared]'));
  const docs = await api(page, `${BASE}/api/files?projectId=${acme}`);
  assert.equal(docs.documents.length, 2, 'both files attached to the project on screen');
  await emit(page, { type: 'response.created', response: {} }, { type: 'response.done', response: { output: [] } });
  await pdfCard.scrollIntoViewIfNeeded();
  await shot(page, 'panel-documents-1440');
  await auditStage(page, 'documents 1440');

  // 8. Typing works while live.
  await drawer.getByLabel('Type to DAVE', { exact: true }).fill('What should I do first this week?');
  await drawer.getByRole('button', { name: 'Send message', exact: true }).click();
  await waitSent(page, e => e.item?.content?.[0]?.text === 'What should I do first this week?');
  await emit(page, { type: 'response.created', response: {} }, { type: 'response.done', response: { output: [] } });

  // 9. Settings sheet with the mood gallery.
  await drawer.getByRole('button', { name: 'Voice settings', exact: true }).click();
  const sheet = drawer.getByRole('group', { name: 'Voice settings' });
  await sheet.getByRole('heading', { name: 'Meet DAVE' }).waitFor();
  assert.ok(await sheet.locator('canvas').count() >= 6, 'every mood is drawn');
  await shot(page, 'settings-1440');
  await sheet.getByRole('heading', { name: 'Meet DAVE' }).scrollIntoViewIfNeeded();
  await shot(page, 'settings-moods-1440');
  await sheet.getByRole('button', { name: 'Close settings', exact: true }).click();

  // 10. End: transcript saved locally; history lists it.
  await drawer.getByRole('button', { name: 'End', exact: true }).click();
  await drawer.getByText('Conversation saved. Talk again any time.', { exact: true }).waitFor();
  const history = await api(page, `${BASE}/api/voice/history`);
  assert.equal(history.sessions.length, 2, 'this conversation and the earlier Approve all one');
  assert.ok(history.sessions[0].lines >= 3 && history.sessions[0].actions >= 1, JSON.stringify(history.sessions[0]));
  assert.equal(await page.evaluate(() => window.__rt.channel.readyState), 'closed');
  await shot(page, 'panel-ended-1440');
  await context.close();


  // 11. Phone width: the drawer becomes full screen; the #voice page renders the stage too.
  const phone = await newPage(390, 844);
  await phone.page.goto(`${BASE}/#focus`);
  await phone.page.getByRole('button', { name: 'Talk to DAVE (Alt+Shift+D)', exact: true }).click();
  const small = phone.page.getByRole('dialog', { name: 'Talk to DAVE' });
  await small.waitFor();
  const full = await small.boundingBox();
  assert.ok(full.width >= 389 && full.height >= 843, `full screen at 390: ${JSON.stringify(full)}`);
  await shot(phone.page, 'panel-390');
  await auditStage(phone.page, 'drawer 390');
  await phone.page.goto(`${BASE}/#voice`);
  await phone.page.getByRole('region', { name: 'Talk to DAVE' }).waitFor();
  await shot(phone.page, 'voice-page-390');
  await phone.context.close();
  const wide = await newPage(1440, 900);
  await wide.page.goto(`${BASE}/#voice`);
  await wide.page.getByRole('region', { name: 'Talk to DAVE' }).waitFor();
  await shot(wide.page, 'voice-page-1440');
  await wide.context.close();

  assert.ok(bodies.length > 10 && bodies.every(b => !b.includes(SENTINEL)), 'the ChatGPT token never reaches the browser');
  assert.ok(callsSeen.every(c => c.url === CALLS), 'only the stubbed Realtime endpoint was called');
} catch (e) {
  await lastPage?.screenshot({ path: `${out}/failure.png` }).catch(() => undefined);
  if (problems.length) console.error(problems.join('\n'));
  throw e;
} finally {
  await browser.close();
  fs.rmSync(work, { recursive: true, force: true });
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`Voice walkthrough passed; screenshots in ${out}`);
