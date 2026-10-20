/**
 * Dev-only UI fixture for screenshots. Never imported by src/.
 *
 * Builds an isolated fixture home (<root>/home, used as HOME) and app home (<root>/app, used as PCC_HOME) with:
 * two git projects with EZ Coder task-store entries, a confirmed finish line with three items and acceptance checks,
 * an EZ Coder session whose first message is DAVE's brief and that ends with run_finished: completed, a commit with
 * the DAVE-Objective trailer, an analyzed meeting (two firm promises, a decision, three tentative ideas) and eight
 * resolved recommendations. Then it runs one work poll and a reconcile, so progress reports and prepared actions exist.
 *
 * No Fathom, no model, no network. It refuses to touch anything outside a temp directory, and only ever wipes a
 * folder it seeded itself (marked with .dave-ui-fixture).
 *
 *   node --experimental-strip-types test/fixtures/seed-ui.ts /tmp/dave-ui-fixture
 *   HOME=/tmp/dave-ui-fixture/home PCC_HOME=/tmp/dave-ui-fixture/app node --experimental-strip-types test/fixtures/serve-ui.ts /tmp/dave-ui-fixture
 *
 * Use serve-ui.ts, not `npm run server`: the real entry starts the Fathom, intel and work schedulers and reads
 * credentials from the Keychain, which a fixture HOME does not isolate.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { sourcePaths } from "../../src/shared/paths.ts";
import { openDb } from "../../src/db/index.ts";
import { repo as makeRepo } from "../../src/db/repo.ts";
import { refresh } from "../../src/model/refresh.ts";
import { intelService } from "../../src/intel/service.ts";
import { ledgerService } from "../../src/intel/ledger.ts";
import { createWorkService } from "../../src/work/service.ts";
import { readWorkEvidence } from "../../src/work/store.ts";
import { meetingStore } from "../../src/meetings/store.ts";
import { instructionsHash } from "../../src/meetings/prompt.ts";
import { meetingFixture } from "../meeting-fixtures.ts";

const MARKER = ".dave-ui-fixture";
const DAY = 86_400_000;

function fail(message: string): never {
  console.error(`seed-ui: ${message}`);
  process.exit(1);
}

/** The root must be a fresh or previously seeded folder inside a temp directory. Never the real home or app data. */
function safeRoot(arg: string | undefined): string {
  if (!arg) fail("usage: node --experimental-strip-types test/fixtures/seed-ui.ts <root under /tmp or the OS temp dir>");
  const root = path.resolve(arg);
  const temps = [...new Set(["/tmp", "/private/tmp", os.tmpdir(), fs.realpathSync(os.tmpdir())].map((t) => path.resolve(t)))];
  if (!temps.some((t) => root.startsWith(`${t}${path.sep}`))) fail(`refusing ${root}: the fixture root must be inside ${temps.join(" or ")}`);
  if (root === os.homedir() || root.includes(".portfolio-command-center")) fail(`refusing ${root}: that looks like real data`);
  if (fs.existsSync(root)) {
    const entries = fs.readdirSync(root);
    if (entries.length && !entries.includes(MARKER)) fail(`refusing ${root}: it exists, is not empty and was not made by this seeder`);
    fs.rmSync(root, { recursive: true, force: true });
  }
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, MARKER), "Temporary DAVE UI fixture. Safe to delete.\n");
  return fs.realpathSync(root);
}

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });

function gitProject(dir: string, files: Record<string, string>, message: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  git(dir, "add", ".");
  git(dir, "commit", "-qm", message);
}

function writeJsonl(file: string, rows: Record<string, unknown>[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

const iso = (ms: number): string => new Date(ms).toISOString();
const day = (ms: number): string => iso(ms).slice(0, 10);

async function main(): Promise<void> {
  const root = safeRoot(process.argv[2]);
  const home = path.join(root, "home");
  const paths = sourcePaths(home, path.join(root, "app"));
  const now = Date.now();

  // Two projects: real git repos, each registered in EZ Coder's task store so discovery finds them.
  const acmeDir = path.join(home, "code", "acme-portal");
  const brightDir = path.join(home, "code", "brightside-app");
  gitProject(acmeDir, { "README.md": "# Acme booking portal\n" }, "Set up the booking portal");
  gitProject(brightDir, { "README.md": "# Brightside app\n" }, "Set up the Brightside app");
  const sessionDir = (dir: string) => path.join(paths.ezcoder.sessions, `Users_fixture_code_${path.basename(dir)}`);
  const sessionFile = (dir: string, at: number, id: string) => path.join(sessionDir(dir), `${iso(at).replace(/[:.]/g, "-")}_${id}.jsonl`);
  for (const [dir, name] of [[acmeDir, "Acme booking portal"], [brightDir, "Brightside app"]] as const) {
    const key = createHash("sha256").update(dir).digest("hex").slice(0, 16);
    const meta = path.join(paths.ezcoder.taskProjects, key, "meta.json");
    fs.mkdirSync(path.dirname(meta), { recursive: true });
    fs.writeFileSync(meta, JSON.stringify({ path: dir, name }));
    // Earlier EZ Coder sessions (two days, so the project ranks as active). No run_finished row: not work events.
    for (const [ago, id] of [[2 * DAY, "earlier-a"], [3 * 3_600_000, "earlier-b"]] as const) {
      writeJsonl(sessionFile(dir, now - ago, id), [
        { type: "session", version: 2, id: `${path.basename(dir)}-${id}`, timestamp: iso(now - ago), cwd: dir },
        { type: "message", id: "u1", parentId: null, timestamp: iso(now - ago + 1000), message: { role: "user", content: [{ type: "text", text: `Look around the ${name} code` }] } },
      ]);
    }
  }

  const db = openDb(paths.appHome);
  try {
    const repo = makeRepo(db);
    const portfolio = await refresh(paths, repo, new Date(now));
    const all = [...portfolio.active, ...portfolio.other];
    const acme = all.find((p) => p.canonicalPath === fs.realpathSync(acmeDir));
    const bright = all.find((p) => p.canonicalPath === fs.realpathSync(brightDir));
    if (!acme || !bright) fail(`discovery did not find both projects (found: ${all.map((p) => p.name).join(", ") || "none"})`);
    if (!portfolio.active.some((p) => p.id === acme.id)) fail("Acme is not an active project; the work watcher only polls active ones");

    const names = new Map([[acme.id, acme.name], [bright.id, bright.name]]);
    const ledger = ledgerService(db, { now: () => new Date(), projectName: (id) => names.get(id) ?? null });
    const intel = intelService(db, {
      latest: () => repo.latest(),
      workEvidence: (id) => readWorkEvidence(db, id, new Date()),
      onRecommendations: (s) => ledger.observe(s),
    });

    // Eight resolved recommendations from the last two weeks: followed, overridden toward Brightside, and skipped.
    const history: { kind: string; title: string; outcome: string; basis: string; daysAgo: number; actual?: string; note?: string }[] = [
      { kind: "coding", title: "Deliver requirement: Booking search", outcome: "followed", basis: "observed", daysAgo: 12 },
      { kind: "testing", title: "Verify that \"Booking search\" meets the acceptance criteria", outcome: "followed", basis: "explicit", daysAgo: 10 },
      { kind: "coding", title: "Deliver requirement: Email confirmations", outcome: "followed", basis: "observed", daysAgo: 8 },
      { kind: "coding", title: "Deliver requirement: Staff roles", outcome: "overridden", basis: "observed", daysAgo: 7, actual: bright.id },
      { kind: "coding", title: "Deliver requirement: Staff roles", outcome: "overridden", basis: "observed", daysAgo: 5, actual: bright.id },
      { kind: "client_action", title: "Chase Acme for the brand assets", outcome: "skipped", basis: "explicit", daysAgo: 4, note: "Jane is on holiday" },
      { kind: "coding", title: "Deliver requirement: Payment links", outcome: "overridden", basis: "observed", daysAgo: 3, actual: bright.id },
      { kind: "client_action", title: "Chase Acme for the API sandbox", outcome: "skipped", basis: "explicit", daysAgo: 2, note: "Asked on a call instead" },
    ];
    const insertHistory = db.prepare(`INSERT INTO recommendation_log(id, scope, project_id, objective_id, action_kind, title, target_item_ids_json, score, reasons_json,
      recommended_at, outcome, outcome_basis, outcome_at, actual_project_id, actual_title, actual_ref, note) VALUES (?,?,?,?,?,?,'[]',?,'[]',?,?,?,?,?,?,NULL,?)`);
    history.forEach((h, i) => {
      const at = now - h.daysAgo * DAY;
      const id = createHash("sha256").update(`fixture-rec-${i}`).digest("hex").slice(0, 16);
      const objective = createHash("sha256").update(`fixture-obj-${i}`).digest("hex").slice(0, 16);
      insertHistory.run(id, "project", acme.id, objective, h.kind, h.title, 50 - i, iso(at), h.outcome, h.basis, iso(at + DAY / 2),
        h.actual ?? acme.id, h.actual ? "Brightside: onboarding flow" : null, h.note ?? null);
    });

    // A confirmed finish line for Acme with three items and acceptance checks; one item for Brightside.
    intel.putOutcome(acme.id, { desiredOutcome: "Acme staff take and manage bookings in the portal", acceptanceCriteria: ["Acme staff use it for a full week"],
      lock: true, startDate: day(now - 20 * DAY), targetDate: day(now + 25 * DAY) });
    intel.addItem(acme.id, { kind: "requirement", title: "CSV export of bookings", acceptance: ["Export opens in Excel", "Dates use the client's timezone"] });
    intel.addItem(acme.id, { kind: "requirement", title: "Booking calendar view", acceptance: ["Shows a week at a time", "Drag to reschedule"] });
    intel.addItem(acme.id, { kind: "requirement", title: "Cancellation emails", acceptance: ["Customer gets an email within a minute"] });
    intel.putOutcome(bright.id, { desiredOutcome: "Brightside users can onboard themselves", acceptanceCriteria: ["Ten users onboard without help"],
      lock: true, startDate: day(now - 10 * DAY), targetDate: day(now + 40 * DAY) });
    intel.addItem(bright.id, { kind: "requirement", title: "Self-serve onboarding flow", acceptance: ["A new user finishes onboarding in under five minutes"] });
    intel.reconcileSync();

    const objective = intel.projectIntel(acme.id).objective;
    if (!objective?.brief) fail("Acme has no objective with a brief to hand to EZ Coder");
    // The run and the commit both deliver whatever DAVE's pick targets, so the story on screen is consistent.
    const target = intel.store.items(acme.id).find((i) => i.id === objective.targetItemIds[0])?.title;
    if (!target) fail("Acme's top objective targets no item");

    // EZ Coder ran DAVE's brief (Pew started it after a yes) and finished; then a commit landed with the trailer.
    const started = now - 50 * 60_000;
    writeJsonl(sessionFile(acmeDir, started, "fixture"), [
      { type: "session", version: 2, id: "fixture-session-1", timestamp: iso(started), cwd: acmeDir },
      { type: "message", id: "u1", parentId: null, timestamp: iso(started + 1000), message: { role: "user", content: [{ type: "text", text: objective.brief }] } },
      { type: "message", id: "a1", parentId: "u1", timestamp: iso(started + 30 * 60_000), message: { role: "assistant", content: [{ type: "text", text: `Implemented ${target}.` }] } },
      { type: "custom", id: "rf1", parentId: null, timestamp: iso(started + 31 * 60_000), kind: "run_finished", data: { version: 1, generation: 1, outcome: "completed" } },
    ]);
    fs.writeFileSync(path.join(acmeDir, "feature.ts"), "export const ready = true;\n");
    git(acmeDir, "add", ".");
    git(acmeDir, "commit", "-qm", `Add ${target.toLowerCase()}\n\nDAVE-Objective: ${objective.id}`);

    const work = createWorkService({
      db, paths, intel,
      projects: () => (repo.latest()?.active ?? []).filter((p) => p.exists && !p.override.hidden).map((p) => ({ id: p.id, name: p.name, path: p.canonicalPath })),
    });
    work.onProgress((r) => ledger.onProgress(r));
    const polled = await work.poll();
    work.close();

    // An analyzed client meeting: two firm promises, a decision, three ideas (tentative), no model involved.
    const meetings = meetingStore(db);
    const recordingId = "424242";
    const meetingAt = now - 2 * DAY;
    meetings.upsertMeeting(meetingFixture(recordingId, { title: "Acme weekly check-in", startedAt: iso(meetingAt), createdAt: iso(meetingAt + 3_600_000), endedAt: iso(meetingAt + 3_600_000) }), iso(now));
    meetings.setMeetingProject(recordingId, acme.id, "user", iso(now));
    db.prepare("UPDATE meetings SET transcript_hash='fixture', transcript_bytes=0 WHERE recording_id=?").run(recordingId);
    meetings.setStatus(recordingId, "analyzed", null, iso(now));
    const extractionId = "fixture-extraction-1";
    db.prepare(`INSERT INTO meeting_extractions(id, recording_id, instructions_hash, transcript_hash, provider, model, summary_json, stats_json, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(extractionId, recordingId, instructionsHash(meetings.profile().instructions), "fixture", "fixture", "fixture",
      JSON.stringify({ headline: "Acme wants the export this week and the calendar next", overview: "Jane walked through how staff plan the week. The export is the first need; the calendar view follows. A few ideas came up for later.", direction: ["Export first, then the calendar view"] }),
      JSON.stringify({ items: 6 }), iso(now));
    const items: { kind: string; text: string; quote: string; role: string; due: string | null; strength: "firm" | "tentative"; deliverable?: string }[] = [
      { kind: "commitment", text: "Send Jane a sample CSV export of this week's bookings", quote: "I'll send you a sample export by Friday.", role: "me", due: day(now + 3 * DAY), strength: "firm", deliverable: "Sample CSV export" },
      { kind: "commitment", text: "Share a preview of the booking calendar view", quote: "I will share the calendar preview next week.", role: "me", due: day(now + 8 * DAY), strength: "firm", deliverable: "Calendar preview link" },
      { kind: "decision", text: "Build the weekly calendar view before the monthly one", quote: "Agreed, let's go with the weekly view first.", role: "client", due: null, strength: "firm" },
      { kind: "suggestion", text: "Maybe add a PDF export later", quote: "We could maybe add PDF export at some point.", role: "client", due: null, strength: "tentative" },
      { kind: "suggestion", text: "Sync bookings with Google Calendar someday", quote: "It would be nice to sync with Google Calendar someday.", role: "client", due: null, strength: "tentative" },
      { kind: "commitment", text: "Look into SMS reminders", quote: "I might look into SMS reminders if we have time.", role: "me", due: null, strength: "tentative" },
    ];
    const insertItem = db.prepare(`INSERT INTO meeting_items(id, recording_id, extraction_id, kind, text, quote, at_seconds, speaker, speaker_role, project_id, project_source,
      due_date, status, strength, strength_source, deliverable, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'open', ?, 'model', ?, ?, ?)`);
    items.forEach((it, i) => {
      // Same shape as extract.ts item ids (mi- + 24 hex); the item routes refuse anything else.
      const id = `mi-${createHash("sha256").update(`fixture-item-${i}`).digest("hex").slice(0, 24)}`;
      insertItem.run(id, recordingId, extractionId, it.kind, it.text, it.quote, 60 * (i + 1), it.role === "me" ? "Dave Owner" : "Jane Client", it.role, acme.id, "user",
        it.due, it.strength, it.deliverable ?? null, iso(now), iso(now));
    });

    // Meetings feed the plan (firm items only), then Focus is ranked once more.
    intel.reconcileSync();
    intel.close();

    const progress = db.prepare("SELECT COUNT(*) AS n FROM work_progress").get() as { n: number };
    const pending = db.prepare("SELECT COUNT(*) AS n FROM intel_proposals WHERE status='pending'").get() as { n: number };
    console.log(JSON.stringify({
      root, home, appHome: paths.appHome, projects: { acme: acme.id, brightside: bright.id }, meeting: recordingId,
      workEvents: polled.events, progressReports: progress.n, pendingDecisions: pending.n, history: history.length,
    }, null, 2));
  } finally {
    db.close();
  }
}

await main();
