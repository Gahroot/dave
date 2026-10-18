import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sourcePaths } from "../src/shared/paths.ts";
import { createWorkService } from "../src/work/service.ts";
import { readProgress, readWorkEvidence } from "../src/work/store.ts";
import { assessProgress } from "../src/work/assess.ts";
import type { ProgressReport, WorkEvent } from "../src/work/types.ts";
import { intelHarness } from "./intel-fixture.ts";
import { assistantRow, git, initRepo, runFinished, sessionHeader, userRow, workRoot, writeSession } from "./work-fixtures.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

function loop(opts: { github?: boolean } = {}) {
  const root = workRoot(); 
  const paths = sourcePaths(path.join(root, "home"), path.join(root, "app"));
  const repo = path.join(paths.home, "code", "acme");
  initRepo(repo);
  let clock = new Date("2026-10-12T09:00:00.000Z");
  const holder: { h?: ReturnType<typeof intelHarness> } = {};
  const h = intelHarness([{ id: "p1", name: "Acme" }], { workEvidence: (id) => (holder.h ? readWorkEvidence(holder.h.db, id, clock) : []) });
  holder.h = h;
  const ghCalls: string[] = [];
  const work = createWorkService({
    db: h.db, paths, intel: h.intel, projects: () => [{ id: "p1", name: "Acme", path: repo }], now: () => clock,
    runGh: async (cwd) => { ghCalls.push(cwd); return "[]"; },
  });
  if (opts.github) work.setSettings({ github: true });
  cleanups.push(() => { work.close(); h.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { paths, repo, h, work, ghCalls, tick: (iso: string) => { clock = new Date(iso); h.setNow(iso); } };
}

describe("completion loop", () => {
  it("poll → reconcile moves the linked item to implementation_observed (never verified) and reports what is missing; re-poll is a no-op", async () => {
    const { paths, repo, h, work, ghCalls } = loop();
    h.intel.addItem("p1", { kind: "requirement", title: "CSV export of bookings", acceptance: ["Export opens in Excel", "Dates use the client's timezone"] });
    h.intel.addItem("p1", { kind: "requirement", title: "Booking calendar view", acceptance: ["Shows a week at a time"] });
    const csv = h.intel.store.items("p1").find((i) => i.title === "CSV export of bookings");
    const objective = h.intel.projectIntel("p1").objective;
    expect(csv && objective).toBeTruthy();
    const brief = objective?.brief ?? "";
    expect(brief).toContain(`DAVE-Objective: ${objective?.id}`);
    // The brief names the item explicitly; use a session whose request text matches nothing else.
    writeSession(paths.ezcoder.sessions, "Users_x_acme", "2026-10-12T08-00-00_s1.jsonl", [
      sessionHeader("s1", repo), userRow(`Please do this\n\nDAVE-Objective: ${objective?.id}\nDAVE-Items: ${csv?.id}`),
      assistantRow("Done: added the export."), runFinished(1, "completed", "2026-10-12T08:30:00.000Z"),
    ]);
    const seen: ProgressReport[] = [];
    work.onProgress((r) => seen.push(r));
    const first = await work.poll();
    expect(first).toEqual({ events: 1, reports: 1, projects: 1 });
    expect(ghCalls).toEqual([]); // GitHub is off: gh never runs
    const after = h.intel.store.items("p1").find((i) => i.id === csv?.id);
    expect(after?.evidenceState).toBe("implementation_observed");
    expect(work.events({})[0]).toMatchObject({ source: "ezcoder", ref: "s1:1", link: "explicit", objectiveId: objective?.id });
    const [report] = work.progress({});
    expect(seen).toEqual([report]);
    expect(report?.advanced).toEqual([expect.objectContaining({ itemId: csv?.id, from: expect.objectContaining({ evidenceState: "not_implemented" }), to: expect.objectContaining({ evidenceState: "implementation_observed" }) })]);
    expect(report?.verdict).toBe("moved");
    expect(report?.headline).toContain("not verified");
    const missing = report?.stillMissing.map((m) => m.title) ?? [];
    expect(missing).toEqual(expect.arrayContaining(["CSV export of bookings", "Export opens in Excel", "Dates use the client's timezone", "Booking calendar view", "Shows a week at a time"]));
    expect(report?.finishLine).toMatchObject({ verified: 0, observed: 1, total: 2, percentDone: 0 });
    expect(h.intel.store.items("p1").some((i) => i.evidenceState === "verified")).toBe(false);

    const snapshot = h.snapshot();
    expect(await work.poll()).toEqual({ events: 0, reports: 0, projects: 0 });
    expect(h.snapshot()).toBe(snapshot);
    expect(readProgress(h.db, {})).toHaveLength(1);
  });

  it("GitHub runs only when switched on, records consent once, and stays degraded rather than throwing", async () => {
    const { work, ghCalls, repo, tick } = loop();
    fs.appendFileSync(path.join(repo, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/me/acme.git\n');
    expect(work.settings()).toMatchObject({ githubEnabled: false, githubConsentedAt: null });
    expect(work.settings().sources.find((s) => s.source === "github")?.state).toBe("off");
    await work.poll();
    expect(ghCalls).toEqual([]);
    const on = work.setSettings({ github: true });
    expect(on).toMatchObject({ githubEnabled: true, githubConsentedAt: "2026-10-12T09:00:00.000Z" });
    await work.poll();
    expect(ghCalls).toEqual([repo]);
    tick("2026-10-12T09:05:00.000Z");
    await work.poll();
    expect(ghCalls).toHaveLength(1); // at most every 10 minutes
    tick("2026-10-12T09:20:00.000Z");
    work.setSettings({ github: false });
    expect(work.setSettings({ github: true }).githubConsentedAt).toBe("2026-10-12T09:00:00.000Z");
  });

  it("several events in one poll: each report credits only the items that event moved", async () => {
    const { paths, repo, h, work } = loop();
    h.intel.addItem("p1", { kind: "requirement", title: "CSV export of bookings", acceptance: ["Export opens in Excel"] });
    h.intel.addItem("p1", { kind: "requirement", title: "Booking calendar view", acceptance: ["Shows a week at a time"] });
    const csv = h.intel.store.items("p1").find((i) => i.title === "CSV export of bookings");
    const calendar = h.intel.store.items("p1").find((i) => i.title === "Booking calendar view");
    const objective = h.intel.projectIntel("p1").objective;
    if (!csv || !calendar || !objective) throw new Error("fixture: expected two items and an objective");
    // The run is linked to the CSV export only; the commit (same poll) title-matches the calendar view.
    writeSession(paths.ezcoder.sessions, "Users_x_acme", "2026-10-12T08-00-00_s1.jsonl", [
      sessionHeader("s1", repo), userRow(`Please do this\n\nDAVE-Objective: ${objective.id}\nDAVE-Items: ${csv.id}`),
      assistantRow("Done."), runFinished(1, "completed", "2026-10-12T08:30:00.000Z"),
    ]);
    fs.writeFileSync(path.join(repo, "calendar.ts"), "export const week = 7;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", `Add booking calendar view\n\nDAVE-Objective: ${objective.id}`);
    expect(await work.poll()).toMatchObject({ events: 2, reports: 2 });
    expect(h.intel.store.items("p1").filter((i) => i.evidenceState === "implementation_observed").map((i) => i.title).sort())
      .toEqual(["Booking calendar view", "CSV export of bookings"]);
    const bySource = new Map(work.events({}).map((e) => [e.source, e.id]));
    const reportFor = (source: "ezcoder" | "git") => work.progress({}).find((r) => r.eventId === bySource.get(source));
    // The run never touched the calendar view, so its report must not claim it.
    expect(reportFor("ezcoder")?.advanced.map((d) => d.title)).toEqual(["CSV export of bookings"]);
    expect(reportFor("git")?.advanced.map((d) => d.title)).toContain("Booking calendar view");
    // Both were observed in the same poll; the newer work (the commit, made after the 12 Oct run) reads first.
    expect(work.progress({}).map((r) => r.source)).toEqual(["git", "ezcoder"]);
  });

  it("failed runs are never evidence and report a failed verdict", () => {
    const event: WorkEvent = { id: "e1", projectId: "p1", source: "ezcoder", ref: "s:1", kind: "run_finished", outcome: "failed", title: "Build it", summary: null,
      at: "2026-10-12T08:00:00.000Z", objectiveId: null, itemIds: [], link: "none", observedAt: "2026-10-12T08:00:00.000Z" };
    const r = assessProgress({ event, projectName: "Acme", before: [], after: [], plan: null, nextBefore: null, nextAfter: null });
    expect(r.verdict).toBe("failed");
    expect(r.headline).toContain("Nothing was marked as done");
  });
});
