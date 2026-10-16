// Synthetic-only walkthrough of every destination. Isolated temp home and app data: never the operator's real home or
// PCC_HOME, no Keychain (Fathom uses an in-memory key store with no key) and no network. Seeds five shapes of project
// through the real service so the home order, moves, task list and bells & whistles can be inspected, plus synthetic
// inbox requests, analysed meetings and two finished agent runs (stored rows only; execution stays disabled, nothing runs).
// Run: npm run build && node --experimental-strip-types test/intel-ui-fixture.ts
import fs from "node:fs";
import path from "node:path";
import { openDb } from "../src/db/index.ts";
import { memoryKeyStore } from "../src/meetings/credentials.ts";
import { repo as makeRepo } from "../src/db/repo.ts";
import { intelService, type IntelService } from "../src/intel/service.ts";
import { itemId } from "../src/intel/store.ts";
import type { Provenance } from "../src/intel/types.ts";
import { buildServer } from "../src/server/index.ts";
import { sourcePaths } from "../src/shared/paths.ts";
import type { Portfolio } from "../src/shared/types.ts";
import { tempDir, writeJson, writeText } from "./helpers.ts";

const PORT = 4325;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DAY = 86_400_000;
const NAMES = {
  acme: "Acme Clinic Portal",
  gamma: "Gamma Freight Dashboard",
  beta: "Beta Bakery Ordering",
  delta: "Delta Dental Intake, a synthetic client with a deliberately long project name",
  echo: "Echo Gym Memberships",
} as const;

const root = tempDir("dave-intel-ui-");
const paths = sourcePaths(path.join(root, "home"), path.join(root, "app"));
const links: { name: string; cwd: string }[] = [];
Object.values(NAMES).forEach((name, n) => {
  const dir = path.join(paths.home, "code", `synthetic-${n}`);
  writeText(path.join(dir, "README.md"), `# ${name}\n\nSynthetic fixture only. No client data.`);
  writeJson(path.join(paths.ezcoder.taskProjects, `synthetic-${n}`, "meta.json"), { path: dir, name });
  links.push({ name, cwd: dir });
});
// Inbox requests come through the retained EZBoss adapter, as in test/ui-fixture.ts.
const asked = new Date().toISOString();
writeJson(paths.ezboss.links, { projects: links });
writeJson(paths.ezboss.plan, { tasks: [
  { project: NAMES.acme, id: "request-acme", title: "Needs your decision: should cancelled slots reopen straight away?", status: "pending", updatedAt: asked },
  { project: NAMES.gamma, id: "request-gamma", title: "Needs your approval to publish the prepared changes", status: "pending", updatedAt: asked },
  { project: NAMES.beta, id: "request-beta", title: "Needs your approval to publish the prepared changes", status: "pending", updatedAt: asked },
] });

const app = await buildServer(paths, { browserOrigins: [ORIGIN], meetings: { keyStore: memoryKeyStore(), openAIConnected: () => false } });
const portfolio = (await app.inject({ url: "/api/portfolio", headers: { host: `127.0.0.1:${PORT}` } })).json<Portfolio>();
const idOf = (name: string): string => {
  const p = [...portfolio.active, ...portfolio.other].find((x) => x.name === name);
  if (!p) throw new Error(`Synthetic project missing: ${name}`);
  return p.id;
};

await seed(Date.now());
seedMeetings(Date.now());
seedAgentRuns(Date.now());
// Rebuilds attention so open meeting promises and client asks reach the Inbox.
const refreshed = await app.inject({ method: "POST", url: "/api/refresh", headers: { host: `127.0.0.1:${PORT}` } });
if (refreshed.statusCode !== 200) throw new Error(`Synthetic refresh failed: ${refreshed.statusCode}`);
await app.listen({ host: "127.0.0.1", port: PORT });
console.log(`Intel synthetic fixture ready ${ORIGIN}/#focus`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close().then(() => { fs.rmSync(root, { recursive: true, force: true }); process.exit(0); }); });

/** Everything is written through the real service with a movable clock, so timestamps look like weeks of work. */
async function seed(base: number): Promise<void> {
  const clock = { now: new Date(base) };
  const at = (days: number) => { clock.now = new Date(base + days * DAY); };
  const day = (days: number) => new Date(base + days * DAY).toISOString().slice(0, 10);
  const db = openDb(paths.appHome);
  const repo = makeRepo(db);
  const intel: IntelService = intelService(db, { latest: () => repo.latest(), now: () => clock.now });
  const req = (projectId: string, title: string) => itemId(projectId, "requirement", title);
  const heard = (quote: string, label: string, days: number): Provenance => ({
    sourceKind: "meeting", sourceId: `synthetic-${days}`, label, quote, observedAt: new Date(base + days * DAY).toISOString(), confidence: "high", link: null,
  });
  try {
    // Acme: behind schedule with a target date; one of each move, a sent task and bells & whistles.
    const acme = idOf(NAMES.acme);
    at(-30);
    intel.putOutcome(acme, {
      desiredOutcome: "Patients book, move and cancel clinic appointments online, and the front desk sees every booking without phoning anyone",
      acceptanceCriteria: ["A patient books a free slot on their phone in under a minute", "The front desk sees each booking within a minute"],
      startDate: day(-30), targetDate: day(9),
    });
    intel.addFinishLineItems(acme, [
      { title: "Online booking form", acceptance: ["A patient picks a free slot and gets a confirmation", "A taken slot cannot be booked twice"] },
      { title: "Staff calendar view", goal: "So that the front desk sees the whole day at a glance." },
      { title: "Cancel and reschedule links in emails" },
      { title: "Reminder emails the day before" },
      { title: "Patient account login" },
      { title: "Calendar sync with Google", detail: "So that doctors see bookings in the calendar they already use." },
      { title: "Front desk daily list" },
      { title: "Clinic opening hours and holidays" },
    ]);
    at(-12); intel.verifyItem(req(acme, "Online booking form"));
    at(-9); intel.verifyItem(req(acme, "Staff calendar view"));
    at(-8); intel.reopenItem(req(acme, "Reminder emails the day before"), "Sent at midnight instead of the morning");
    at(-6); intel.verifyItem(req(acme, "Clinic opening hours and holidays"));
    at(-5); intel.addItem(acme, { kind: "blocker", title: "Client shares Google Workspace admin access", owner: "client" });
    at(-4); intel.patchItem(req(acme, "Front desk daily list"), { evidenceState: "implementation_observed" });
    at(-3); intel.reopenItem(req(acme, "Reminder emails the day before"), "Still the wrong time zone");
    at(-2); intel.markSent(acme, [req(acme, "Cancel and reschedule links in emails")], true);
    intel.addItem(acme, { kind: "requirement", title: "Dark mode for the staff calendar" });
    intel.addItem(acme, { kind: "requirement", title: "Patient mobile app" });
    intel.patchItem(req(acme, "Patient mobile app"), { lane: "phase2" });
    const waitlist = intel.store.addProposal({
      projectId: acme, kind: "new_requirement", material: true, summary: "Waiting list when a day is full", itemId: req(acme, "Waiting list when a day is full"),
      patch: { op: "create_item", item: { kind: "requirement", title: "Waiting list when a day is full", owner: "client" } },
      provenance: [heard("When Mondays fill up people just give up. Can they join a waiting list instead?", "Call with Acme Clinic (synthetic)", -2)],
    }, clock.now.toISOString());
    if (waitlist) intel.resolveProposal(waitlist.id, true, null, "finish_line");
    at(-1);
    intel.store.addProposal({
      projectId: acme, kind: "new_requirement", material: true, summary: "Text message reminders as well as email", detail: "Heard on the latest call.",
      itemId: req(acme, "Text message reminders"), patch: { op: "create_item", item: { kind: "requirement", title: "Text message reminders", owner: "client" } },
      provenance: [heard("Could patients get a text as well? Half of them never read email.", "Call with Acme Clinic (synthetic)", -1)],
    }, clock.now.toISOString());

    // Gamma: no target date and stalled for two weeks; three verified items the client has not seen.
    const gamma = idOf(NAMES.gamma);
    at(-40);
    intel.putOutcome(gamma, { desiredOutcome: "Dispatchers see every truck's status on one screen and stop phoning drivers for updates", acceptanceCriteria: ["Every active truck appears within a minute of moving"] });
    intel.addFinishLineItems(gamma, ["Live truck map", "Driver status updates", "Delayed delivery alerts", "Daily dispatch report", "Customer ETA page"].map((title) => ({ title })));
    at(-18); intel.verifyItem(req(gamma, "Live truck map"));
    at(-16); intel.verifyItem(req(gamma, "Driver status updates"));
    at(-15); intel.verifyItem(req(gamma, "Daily dispatch report"));
    intel.patchItem(req(gamma, "Customer ETA page"), { dueDate: day(20) });

    // Beta: just started, with a dependency chain and a promise of your own.
    const beta = idOf(NAMES.beta);
    at(-2);
    intel.putOutcome(beta, { desiredOutcome: "Customers order cakes online for pickup, and the bakery sees tomorrow's orders by 6pm", acceptanceCriteria: [], startDate: day(-2), targetDate: day(40) });
    intel.addItem(beta, { kind: "requirement", title: "Cake catalogue with photos" });
    intel.addItem(beta, { kind: "requirement", title: "Order and pickup time form", dependsOn: [req(beta, "Cake catalogue with photos")] });
    intel.addItem(beta, { kind: "requirement", title: "Card payment at checkout", dependsOn: [req(beta, "Order and pickup time form")] });
    intel.addItem(beta, { kind: "requirement", title: "Tomorrow's orders list for the bakery" });
    intel.addItem(beta, { kind: "commitment", title: "Send the bakery a first preview", owner: "me", dueDate: day(7) });

    // Delta: finish line not confirmed yet; DAVE has a draft waiting.
    const delta = idOf(NAMES.delta);
    at(-3);
    intel.addItem(delta, { kind: "requirement", title: "Patient intake questionnaire" });
    intel.addItem(delta, { kind: "requirement", title: "Insurance card photo upload" });
    intel.store.addProposal({
      projectId: delta, kind: "outcome_draft", material: true, summary: "Draft finish line for Delta Dental Intake",
      patch: { op: "set_outcome", desiredOutcome: "New patients fill in intake forms before their first visit, and reception never retypes them", acceptanceCriteria: ["A new patient completes the form on a phone"] },
      provenance: [heard("We spend twenty minutes per new patient copying paper forms.", "Kick-off with Delta Dental (synthetic)", -3)],
    }, clock.now.toISOString());

    // Echo: delivered and signed off.
    const echo = idOf(NAMES.echo);
    at(-60);
    intel.putOutcome(echo, { desiredOutcome: "Members join, pay and book classes online", acceptanceCriteria: [], targetDate: day(-10) });
    intel.addFinishLineItems(echo, ["Membership sign-up", "Class booking", "Monthly billing"].map((title) => ({ title })));
    at(-30); intel.verifyItem(req(echo, "Membership sign-up"));
    at(-25); intel.verifyItem(req(echo, "Class booking"));
    at(-20); intel.verifyItem(req(echo, "Monthly billing"));
    at(-18); intel.setStep(echo, "live", true);
    at(-15); intel.setStep(echo, "using", true);
    at(-12); intel.setStep(echo, "signed_off", true);

    at(0);
    intel.reconcileSync();
  } finally {
    intel.close();
    db.close();
  }
}

/** Two finished runs, so the Agent desk list and run panels have content. Terminal statuses only: nothing dispatches. */
function seedAgentRuns(base: number): void {
  const iso = (hours: number) => new Date(base + hours * 3_600_000).toISOString();
  const db = openDb(paths.appHome);
  try {
    const run = db.prepare(`INSERT INTO agent_runs(id, project_id, request_key, request_json, title, prompt, criteria_json, checks_json, status, branch, next_prompt, reason, created_at, updated_at)
      VALUES (?, ?, ?, '{}', ?, ?, ?, '[]', ?, ?, '', ?, ?, ?)`);
    run.run("00000000-0000-4000-8000-000000000001", idOf(NAMES.acme), "synthetic-run-1", "Cancel and reschedule links in emails", "Synthetic prompt only.",
      JSON.stringify(["A patient can cancel from the email", "The slot reopens straight away"]), "stopped", "dave/synthetic-run-1", "Stopped by you", iso(-5), iso(-4));
    run.run("00000000-0000-4000-8000-000000000002", idOf(NAMES.beta), "synthetic-run-2", "Cake catalogue with photos", "Synthetic prompt only.",
      JSON.stringify(["Every cake shows a photo and a price"]), "failed", "dave/synthetic-run-2", "The agent stopped responding", iso(-30), iso(-29));
  } finally { db.close(); }
}

/** Analysed meetings written straight to the temp database, as if Fathom had synced. No transcript, key or network. */
function seedMeetings(base: number): void {
  const iso = (days: number) => new Date(base + days * DAY).toISOString();
  const db = openDb(paths.appHome);
  try {
    const meeting = db.prepare(`INSERT INTO meetings(recording_id, title, created_at, started_at, status, skip_reason, error, project_id, project_source, first_seen_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'rule', ?, ?)`);
    const rows: [string, string, number, string, string | null, string | null, string | null][] = [
      ["9001", "Acme Clinic weekly (synthetic)", -1, "analyzed", null, null, idOf(NAMES.acme)],
      ["9002", "Gamma Freight check-in (synthetic)", -20, "analyzed", null, null, idOf(NAMES.gamma)],
      ["9003", "Beta Bakery kick-off (synthetic)", -2, "analyzed", null, null, idOf(NAMES.beta)],
      ["9004", "Team standup (synthetic)", -1, "skipped", "Title contains \"standup\"", null, null],
      ["9005", "Delta Dental intro (synthetic)", -3, "failed", null, "Transcript was not ready yet", idOf(NAMES.delta)],
    ];
    for (const [id, title, days, status, skip, error, project] of rows) meeting.run(id, title, iso(days), iso(days), status, skip, error, project, iso(days), iso(days));
    const item = db.prepare(`INSERT INTO meeting_items(id, recording_id, kind, text, quote, at_seconds, speaker, speaker_role, project_id, project_source, due_phrase, due_date, feature_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'meeting', ?, ?, ?, 'open', ?, ?)`);
    const feature = (title: string, outcome: string) => JSON.stringify({ title, outcome, acceptance: ["Works on a phone", "The client can try it without help"] });
    const items: [string, string, string, string, string, number, string, string, string, string | null, string | null, string | null, number][] = [
      ["mi-000000000000000000000001", "9001", "commitment", "Send Acme the booking form preview link", "I'll send you the preview link by Wednesday", 312, "Dave", "me", NAMES.acme, "by Wednesday", iso(-2).slice(0, 10), null, -1],
      ["mi-000000000000000000000002", "9001", "commitment", "Check the reminder time zone with the clinic", "Let me check which time zone the reminders use", 640, "Dave", "me", NAMES.acme, "tomorrow", iso(1).slice(0, 10), null, -1],
      ["mi-000000000000000000000003", "9003", "commitment", "Share three catalogue layouts with the bakery", "I'll mock up three layouts for the catalogue next week", 455, "Dave", "me", NAMES.beta, "next week", iso(8).slice(0, 10), null, -2],
      ["mi-000000000000000000000004", "9001", "pain_point", "Front desk retypes every phone booking", "Every phone booking gets typed in twice, once on paper and once in the system", 905, "Jane (synthetic client)", "client", NAMES.acme, null, null, feature("Quick phone booking", "Front desk books a phone caller in one step"), -1],
      ["mi-000000000000000000000005", "9002", "suggestion", "Colour delayed trucks red on the map", "Could the late trucks just go red so we spot them?", 220, "Sam (synthetic client)", "client", NAMES.gamma, null, null, null, -20],
      ["mi-000000000000000000000006", "9003", "decision", "Pickup only for launch, no delivery", "Let's keep it pickup only until Easter", 1210, "Pat (synthetic client)", "client", NAMES.beta, null, null, null, -2],
    ];
    for (const [id, rec, kind, text, quote, at, speaker, role, project, phrase, due, feat, days] of items) item.run(id, rec, kind, text, quote, at, speaker, role, idOf(project), phrase, due, feat, iso(days), iso(days));
  } finally { db.close(); }
}
