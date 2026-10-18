import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { openDb } from "../src/db/index.ts";
import { intelService } from "../src/intel/service.ts";
import { createNextService } from "../src/intel/next.ts";
import type { ProgressReport } from "../src/work/types.ts";
import type { Db } from "../src/db/index.ts";
import { tempDir } from "./helpers.ts";
import { fakeLedger, fakeMeetings, report } from "./intel-prepare-fixture.ts";

const homes: string[] = []; const dbs: Db[] = [];
afterEach(() => { for (const d of dbs.splice(0)) { try { d.close(); } catch { /* already closed */ } } for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true }); });

function world(home = tempDir("dave-briefing-")) {
  if (!homes.includes(home)) homes.push(home);
  const db = openDb(home); dbs.push(db);
  const clock = { now: new Date("2026-10-12T09:00:00.000Z") };
  const reports: ProgressReport[] = [];
  const intel = intelService(db, { latest: () => null, now: () => clock.now });
  const next = createNextService({
    db, intel, meetings: fakeMeetings(), ledger: fakeLedger().ledger, now: () => clock.now,
    work: { progress: (q) => reports.filter((r) => !q.since || r.observedAt >= q.since) },
  });
  const rows = () => db.prepare("SELECT caller, last_briefed_at FROM briefing_cursors ORDER BY caller").all();
  return { home, db, clock, reports, next, rows };
}

describe("briefing window", () => {
  it("with no stored row uses now - 24h", () => {
    const w = world();
    const b = w.next.briefing({ caller: "pew" });
    expect(b).toMatchObject({ since: "2026-10-11T09:00:00.000Z", sinceSource: "default_24h", generatedAt: "2026-10-12T09:00:00.000Z" });
  });

  it("caller=pew writes the cursor; the next call returns only newer progress as last_asked", () => {
    const w = world();
    w.reports.push(report({ eventId: "old", at: "2026-10-12T08:00:00.000Z" }));
    const first = w.next.briefing({ caller: "pew" });
    expect(first.progress.map((r) => r.eventId)).toEqual(["old"]);
    expect(w.rows()).toEqual([{ caller: "pew", last_briefed_at: "2026-10-12T09:00:00.000Z" }]);
    w.clock.now = new Date("2026-10-12T11:00:00.000Z");
    w.reports.push(report({ eventId: "new", at: "2026-10-12T10:00:00.000Z" }));
    const second = w.next.briefing({ caller: "pew" });
    expect(second).toMatchObject({ since: "2026-10-12T09:00:00.000Z", sinceSource: "last_asked" });
    expect(second.progress.map((r) => r.eventId)).toEqual(["new"]);
  });

  it("work that happened before the last briefing but was seen after it still counts as new", () => {
    const w = world();
    w.next.briefing({ caller: "pew" }); // cursor = 09:00
    w.clock.now = new Date("2026-10-12T10:00:00.000Z");
    // Merged at 08:55, but the GitHub poll only saw it at 09:40.
    w.reports.push(report({ eventId: "late", at: "2026-10-12T08:55:00.000Z", observedAt: "2026-10-12T09:40:00.000Z" }));
    const b = w.next.briefing({ caller: "pew" });
    expect(b.sinceSource).toBe("last_asked");
    expect(b.progress.map((r) => r.eventId)).toEqual(["late"]);
  });

  it("the cursor survives a restart", () => {
    const w = world();
    w.next.briefing({ caller: "pew" });
    w.db.close();
    const again = world(w.home);
    again.clock.now = new Date("2026-10-12T12:00:00.000Z");
    expect(again.next.briefing({ caller: "pew" })).toMatchObject({ since: "2026-10-12T09:00:00.000Z", sinceSource: "last_asked" });
  });

  it("clamps a 30-day-old cursor to 14 days", () => {
    const w = world();
    w.db.prepare("INSERT INTO briefing_cursors(caller,last_briefed_at,updated_at) VALUES ('voice',?,?)").run("2026-09-12T09:00:00.000Z", "2026-09-12T09:00:00.000Z");
    expect(w.next.briefing({ caller: "voice" })).toMatchObject({ since: "2026-09-28T09:00:00.000Z", sinceSource: "last_asked" });
  });

  it("an explicit since wins over the cursor", () => {
    const w = world();
    w.next.briefing({ caller: "pew" });
    expect(w.next.briefing({ caller: "pew", since: "2026-10-10T00:00:00.000Z" })).toMatchObject({ since: "2026-10-10T00:00:00.000Z", sinceSource: "explicit" });
  });

  it("no caller writes no row", () => {
    const w = world();
    w.next.briefing({});
    expect(w.rows()).toEqual([]);
  });

  it("counts objective changes and work events since the window start", () => {
    const w = world();
    w.db.prepare(`INSERT INTO work_events(id,project_id,source,ref,kind,outcome,title,summary,at,objective_id,item_ids_json,link,observed_at)
      VALUES ('e1','p1','git','abc','commit','committed','Fix','',?,NULL,'[]','none',?)`).run("2026-10-12T08:00:00.000Z", "2026-10-12T08:00:00.000Z");
    w.db.prepare(`INSERT INTO work_events(id,project_id,source,ref,kind,outcome,title,summary,at,objective_id,item_ids_json,link,observed_at)
      VALUES ('e0','p1','git','abd','commit','committed','Old','',?,NULL,'[]','none',?)`).run("2026-10-01T08:00:00.000Z", "2026-10-01T08:00:00.000Z");
    const b = w.next.briefing({});
    expect(b.changedSince.workEvents).toBe(1);
    expect(b.decisionsWaiting).toBe(0);
    expect(b.alsoReady.length).toBeLessThanOrEqual(3);
  });
});
