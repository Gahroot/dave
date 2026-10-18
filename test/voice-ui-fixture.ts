// Talk to DAVE: synthetic-only isolated server for the voice walkthrough. Temp home and app data only (never the real
// home, PCC_HOME or Keychain). The OpenAI connection is a fake that hands out a synthetic token, and the Realtime
// client-secret mint is a fake fetch, so nothing reaches the network. Documents use the local extractor on files the
// walkthrough generates. Run: npm run build && node --experimental-strip-types test/voice-ui-fixture.ts
import fs from "node:fs";
import path from "node:path";
import { openDb, type Db } from "../src/db/index.ts";
import { repo as makeRepo } from "../src/db/repo.ts";
import { intelService } from "../src/intel/service.ts";
import { itemId } from "../src/intel/store.ts";
import { memoryKeyStore } from "../src/meetings/credentials.ts";
import { meetingStore } from "../src/meetings/store.ts";
import { createProviderService, type OwnedAuth } from "../src/providers/index.ts";
import { buildServer } from "../src/server/index.ts";
import { sourcePaths } from "../src/shared/paths.ts";
import type { Portfolio } from "../src/shared/types.ts";
import { tempDir, writeJson, writeText } from "./helpers.ts";
import { meetingFixture } from "./meeting-fixtures.ts";

const PORT = 4327;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DAY = 86_400_000;
/** Must never reach the browser: the walkthrough fails if any response body contains it. */
const TOKEN_SENTINEL = "SYNTHETIC_CHATGPT_TOKEN_SENTINEL";
const NAMES = { acme: "Acme Clinic Portal", gamma: "Gamma Freight Dashboard", beta: "Beta Bakery Ordering" } as const;

const root = tempDir("dave-voice-ui-");
const paths = sourcePaths(path.join(root, "home"), path.join(root, "app"));
Object.values(NAMES).forEach((name, n) => {
  const dir = path.join(paths.home, "code", `synthetic-${n}`);
  writeText(path.join(dir, "README.md"), `# ${name}\n\nSynthetic fixture only. No client data.`);
  writeJson(path.join(paths.ezcoder.taskProjects, `synthetic-${n}`, "meta.json"), { path: dir, name });
});

const fakeAuth = {
  status: () => ({ provider: "openai", storage: "session", state: "connected" }),
  restore() {}, async connect() {}, cancel() {}, disconnect() {}, dispose() {},
  async getCredentials() { return { accessToken: TOKEN_SENTINEL, accountId: "synthetic-account", expiresAt: Date.now() + 3_600_000 }; },
} as unknown as OwnedAuth;
const providers = createProviderService({ authFactory: () => fakeAuth, inference: async () => "{}" });
providers.restore("session");

/** Fake Realtime mint: only the client-secrets endpoint, only with the synthetic token. */
const mint = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const auth = new Headers(init?.headers).get("authorization");
  if (url !== "https://api.openai.com/v1/realtime/client_secrets" || auth !== `Bearer ${TOKEN_SENTINEL}`) return new Response("{}", { status: 400 });
  return Response.json({ value: "ek_synthetic_fixture_secret", expires_at: Math.floor(Date.now() / 1000) + 600 });
}) as typeof fetch;

const app = await buildServer(paths, {
  providers, browserOrigins: [ORIGIN],
  meetings: { keyStore: memoryKeyStore(), openAIConnected: () => false, inference: async () => "{}" },
  voice: { fetch: mint },
});
const portfolio = (await app.inject({ url: "/api/portfolio", headers: { host: `127.0.0.1:${PORT}` } })).json<Portfolio>();
const idOf = (name: string): string => {
  const p = [...portfolio.active, ...portfolio.other].find((x) => x.name === name);
  if (!p) throw new Error(`Synthetic project missing: ${name}`);
  return p.id;
};
seed(Date.now());
// Refresh once more through the guarded route so the seeded meeting promises join the Inbox in refresh's save step.
{
  const headers = { host: `127.0.0.1:${PORT}`, origin: ORIGIN };
  const token = (await app.inject({ url: "/api/security/csrf", headers })).json<{ token: string }>().token;
  const refreshed = await app.inject({ method: "POST", url: "/api/refresh", headers: { ...headers, "x-dave-csrf": token } });
  if (refreshed.statusCode !== 200) throw new Error(`Fixture refresh failed: ${refreshed.statusCode}`);
}
await app.listen({ host: "127.0.0.1", port: PORT });
console.log(`Voice synthetic fixture ready ${ORIGIN}/#focus`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close().then(() => { fs.rmSync(root, { recursive: true, force: true }); process.exit(0); }); });

/** Acme is behind with a near target date, Gamma has a finish line and no date, Beta has no finish line yet. */
function seed(base: number): void {
  const clock = { now: new Date(base) };
  const at = (days: number) => { clock.now = new Date(base + days * DAY); };
  const day = (days: number) => new Date(base + days * DAY).toISOString().slice(0, 10);
  const db = openDb(paths.appHome);
  const repo = makeRepo(db);
  const intel = intelService(db, { latest: () => repo.latest(), now: () => clock.now });
  try {
    const acme = idOf(NAMES.acme);
    at(-20);
    intel.putOutcome(acme, { desiredOutcome: "Patients book clinic appointments online and the front desk sees every booking", acceptanceCriteria: ["A patient books a slot on a phone in under a minute"], startDate: day(-20), targetDate: day(6) });
    intel.addFinishLineItems(acme, ["Online booking form", "Staff calendar view", "Reminder emails"].map((title) => ({ title })));
    at(-8); intel.verifyItem(itemId(acme, "requirement", "Online booking form"));
    const gamma = idOf(NAMES.gamma);
    at(-30);
    intel.putOutcome(gamma, { desiredOutcome: "Dispatchers see every truck on one screen and stop phoning drivers", acceptanceCriteria: ["Every active truck appears within a minute of moving"] });
    intel.addFinishLineItems(gamma, ["Live truck map", "Driver status updates", "Customer ETA page"].map((title) => ({ title })));
    at(-25); intel.verifyItem(itemId(gamma, "requirement", "Live truck map"));
    const beta = idOf(NAMES.beta);
    at(-2);
    intel.addItem(beta, { kind: "requirement", title: "Cake catalogue with photos" });
    seedMeetingNoise(db, base, { acme, gamma, beta });
    at(0);
    intel.reconcileSync();
  } finally {
    intel.close();
    db.close();
  }
}

/**
 * Meeting noise for Clean up: synthetic calls and promises only. Acme: two overdue promises, one old promise with no
 * date, one old client ask and one overdue promise you already set yourself (hidden unless "Include ones you
 * confirmed"). Gamma: one that looks done and one old promise with no date, but nothing overdue, so the direction
 * walkthrough's focus item stays Gamma's next objective. Beta: one overdue promise. The walkthrough clears all of it
 * before the direction steps, so their ranking matches a portfolio without meeting noise.
 */
function seedMeetingNoise(db: Db, base: number, ids: { acme: string; gamma: string; beta: string }): void {
  const meetings = meetingStore(db);
  const iso = (days: number) => new Date(base + days * DAY).toISOString();
  const day = (days: number) => iso(days).slice(0, 10);
  const calls = [
    { rec: "9001", projectId: ids.acme, title: "Acme weekly check-in", days: -40 },
    { rec: "9002", projectId: ids.gamma, title: "Gamma dispatch review", days: -25 },
    { rec: "9003", projectId: ids.beta, title: "Beta kickoff", days: -5 },
  ];
  for (const c of calls) {
    meetings.upsertMeeting(meetingFixture(c.rec, { title: c.title, startedAt: iso(c.days), createdAt: iso(c.days), endedAt: iso(c.days + 0.04) }), iso(c.days));
    meetings.setMeetingProject(c.rec, c.projectId, "user", iso(c.days));
  }
  type Row = { rec: string; projectId: string; kind: string; role: string; text: string; due: number | null; status?: string; source?: string; suggested?: string };
  const rows: Row[] = [
    { rec: "9001", projectId: ids.acme, kind: "commitment", role: "me", text: "Send Acme the revised booking mockups", due: -30 },
    { rec: "9001", projectId: ids.acme, kind: "commitment", role: "me", text: "Share the staging link with the front desk", due: -12 },
    { rec: "9001", projectId: ids.acme, kind: "commitment", role: "me", text: "Look into SMS reminders for no-shows", due: null },
    { rec: "9001", projectId: ids.acme, kind: "suggestion", role: "client", text: "Add a waitlist for cancelled slots", due: null },
    { rec: "9001", projectId: ids.acme, kind: "commitment", role: "me", text: "Fix the double-booking bug before launch", due: -15, source: "user" },
    { rec: "9002", projectId: ids.gamma, kind: "commitment", role: "me", text: "Write up the ETA page spec", due: -10, status: "looks_done", suggested: "done" },
    { rec: "9002", projectId: ids.gamma, kind: "commitment", role: "me", text: "Check the GPS vendor contract terms", due: null },
    { rec: "9003", projectId: ids.beta, kind: "commitment", role: "me", text: "Send the bakery the order form draft", due: -2 },
  ];
  const insert = db.prepare(`INSERT INTO meeting_items(id, recording_id, kind, text, quote, at_seconds, speaker, speaker_role, project_id, project_source, due_date,
    status, status_source, suggested_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  rows.forEach((r, n) => {
    const at = iso(calls.find((c) => c.rec === r.rec)?.days ?? 0);
    insert.run(`mi-${(n + 1).toString(16).padStart(24, "0")}`, r.rec, r.kind, r.text, `Synthetic quote ${n + 1}.`, 60 * (n + 1), r.role === "me" ? "Dave Owner" : "Jane Client",
      r.role, r.projectId, "user", r.due === null ? null : day(r.due), r.status ?? "open", r.source ?? "model", r.suggested ?? null, at, at);
  });
}
