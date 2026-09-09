import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildServer } from "../src/server/index.ts";
import { sourcePaths } from "../src/shared/paths.ts";
import type { Portfolio } from "../src/shared/types.ts";
import { tempDir, writeJson, writeText } from "./helpers.ts";

const root = tempDir("pcc-zero-");
const home = path.join(root, "home");
const appHome = path.join(root, "app");
const paths = sourcePaths(home, appHome);
let app: Awaited<ReturnType<typeof buildServer>>;

const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
const stamp = (hoursAgo: number) =>
  new Date(Date.now() - hoursAgo * 3_600_000).toISOString().replace(/[:.]/g, "-");

function gitRepo(dir: string, subject: string) {
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", subject);
}

/** A busy project, a quiet one, and a stale one — no user input anywhere. */
const busy = path.join(home, "code", "busy");
const quiet = path.join(home, "code", "quiet");

beforeAll(async () => {
  // Busy: recent sessions across several days, a running task, uncommitted work.
  fs.mkdirSync(busy, { recursive: true });
  writeText(path.join(busy, "README.md"), "# Busy\n\nInvoicing portal.\n");
  gitRepo(busy, "add invoice export");
  writeText(path.join(busy, "scratch.txt"), "uncommitted");

  const busySessions = path.join(paths.ezcoder.sessions, "Users_x_busy");
  for (const [hours, request] of [
    [2, "wire the export screen to the invoice API"],
    [26, "earlier work on the schema"],
    [50, "set up the project"],
  ] as const) {
    writeText(
      path.join(busySessions, `${stamp(hours)}_s.jsonl`),
      `${JSON.stringify({ type: "session", timestamp: iso(hours), cwd: busy })}\n${JSON.stringify({
        type: "message",
        message: { role: "user", content: request },
      })}\n`,
    );
  }
  writeJson(path.join(paths.ezcoder.taskProjects, "busy", "meta.json"), { path: busy, name: "busy" });
  writeJson(path.join(paths.ezcoder.taskProjects, "busy", "tasks.json"), [
    { id: "t1", title: "wire export to the invoice API", status: "in-progress", updatedAt: iso(3) },
    { id: "t2", title: "schema migration", status: "done", updatedAt: iso(28) },
  ]);

  // Quiet: a real project, but nothing has happened for months.
  fs.mkdirSync(quiet, { recursive: true });
  writeText(path.join(quiet, "README.md"), "# Quiet\n\nAn old side project.\n");
  gitRepo(quiet, "initial commit");
  writeJson(paths.ezboss.links, { projects: [{ name: "quiet", cwd: quiet }] });

  app = await buildServer(paths);
});

async function portfolio(fresh = true): Promise<Portfolio> {
  const res = await app.inject({ method: fresh ? "POST" : "GET", url: fresh ? "/api/refresh" : "/api/portfolio" });
  expect(res.statusCode).toBeLessThan(400);
  return res.json() as Portfolio;
}

describe("first launch requires no setup", () => {
  it("does not create a compulsory chore from running and dirty facts alone", async () => {
    const p = await portfolio();
    expect(p.today.some((item) => item.projectName === "busy")).toBe(false);
    expect(p.inbox).toEqual([]);
  });
  it("opens with an honestly quiet Today and no setup gate", async () => {
    const p = await portfolio();
    expect(p.today).toEqual([]);
    // There is no onboarding flag, no classification, no setup queue.
    expect("onboardingRequired" in p).toBe(false);
    expect(JSON.stringify(p)).not.toMatch(/unclassified|setupIncomplete|classification/);
  });

  it("puts the project with real recent evidence under Active", async () => {
    const p = await portfolio();
    expect(p.active.map((x) => x.name)).toContain("busy");
    expect(p.active.map((x) => x.name)).not.toContain("quiet");
  });

  it("puts the project with no recent evidence under Other, unasked", async () => {
    const p = await portfolio();
    expect(p.other.map((x) => x.name)).toContain("quiet");
  });

  it("answers the four questions automatically for the active project", async () => {
    const p = await portfolio();
    const s = p.active.find((x) => x.name === "busy")!.summary;
    expect(s.recentFocus).toBe("wire the export screen to the invoice API");
    expect(s.completed).toContain("add invoice export");
    expect(s.unfinished).toBe("1 uncommitted file(s)");
    expect(s.suggestedNextAction).toBe("Review and commit the uncommitted work");
    expect(s.evidence.some((e) => e.kind === "ezcoder-task")).toBe(false);
  });

  it("shows the evidence behind the summary without demanding approval", async () => {
    const p = await portfolio();
    const s = p.active.find((x) => x.name === "busy")!.summary;
    expect(s.evidence.length).toBeGreaterThan(0);
    expect(s.evidence.some((e) => e.kind === "session")).toBe(true);
    expect(s.edited).toBe(false);
  });

  it("explains why a project ranked as relevant", async () => {
    const p = await portfolio();
    const busyProject = p.active.find((x) => x.name === "busy")!;
    const codes = busyProject.relevance.reasons.map((r) => r.code);
    expect(codes).not.toContain("running-worker");
    expect(codes).toContain("recent-session");
    expect(busyProject.relevance.score).toBeGreaterThan(0);
  });

  it("raises no issue simply because business metadata is absent", async () => {
    const p = await portfolio();
    expect(p.issues).toEqual([]);
    for (const item of p.inbox) {
      expect(["failed-run", "agent-question", "ready-for-review", "conflicting-work", "approval-request"]).toContain(
        item.kind,
      );
    }
  });

  it("reuses the stored summary when nothing changed", async () => {
    const first = await portfolio();
    const second = await portfolio();
    const a = first.active.find((x) => x.name === "busy")!.summary;
    const b = second.active.find((x) => x.name === "busy")!.summary;
    expect(b.generatedAt).toBe(a.generatedAt);
  });

  it("does not regenerate when ignored EZ Coder tasks change", async () => {
    const before = (await portfolio()).active.find((x) => x.name === "busy")!.summary;
    writeJson(path.join(paths.ezcoder.taskProjects, "busy", "tasks.json"), [
      { id: "t1", title: "wire export to the invoice API", status: "blocked", updatedAt: iso(1) },
    ]);
    const after = (await portfolio()).active.find((x) => x.name === "busy")!.summary;
    expect(after).toEqual(before);
  });
});

describe("chosen summary persistence", () => {
  it("keeps acknowledged choices through evidence refresh and server restart with isolated sources", async () => {
    const root = tempDir('pcc-chosen-');
    const sources = sourcePaths(path.join(root, 'home'), path.join(root, 'app'));
    const dir = path.join(sources.home, 'code', 'chosen');
    writeText(path.join(dir, 'README.md'), '# Synthetic chosen');
    writeJson(path.join(sources.ezcoder.taskProjects, 'chosen', 'meta.json'), { path: dir, name: 'Synthetic chosen' });
    const taskFile = path.join(sources.ezcoder.taskProjects, 'chosen', 'tasks.json');
    writeJson(taskFile, [{ id: 't', title: 'ordinary work', status: 'in-progress' }]);
    let server = await buildServer(sources);
    try {
      const initial = (await server.inject('/api/portfolio')).json<Portfolio>();
      let p = initial.other[0]!;
      await server.inject({ method: 'POST', url: `/api/projects/${p.id}/override`, payload: { pinned: true } });
      p = (await server.inject('/api/portfolio')).json<Portfolio>().active.find((x) => x.id === p.id)!;
      const saved = (await server.inject({ method: 'POST', url: `/api/projects/${p.id}/summary`, payload: { suggestedNextAction: 'Prepare one bounded acceptance case' } })).json().summary;
      expect(saved.nextActionEditedAt).toBeTruthy();
      expect(saved.generatedAt).toBe(p.summary.generatedAt);
      writeJson(taskFile, [{ id: 't', title: 'changed source evidence', status: 'done' }]);
      const refreshed = (await server.inject({ method: 'POST', url: '/api/refresh' })).json<Portfolio>();
      expect(refreshed.active.find((x) => x.id === p.id)?.summary).toEqual(saved);
      expect(refreshed.inbox).toEqual([]);
      await server.close();
      server = await buildServer(sources);
      const reopened = (await server.inject({ method: 'POST', url: '/api/refresh' })).json<Portfolio>();
      expect(reopened.active.find((x) => x.id === p.id)?.summary).toEqual(saved);
      expect(reopened.active.find((x) => x.id === p.id)?.override.pinned).toBe(true);
    } finally { await server.close(); }
  });
});

describe("fifty-project coverage", () => {
  it("bounds deep scans, reports over-cap requests, hidden/missing projects and failed reads honestly", async () => {
    const fixture = tempDir("pcc-scale-");
    const sources = sourcePaths(path.join(fixture, "home"), path.join(fixture, "app"));
    const links = [];
    const tasks = [];
    for (let n = 0; n < 50; n++) {
      const dir = path.join(sources.home, "code", `p${String(n).padStart(2, "0")}`);
      if (n !== 49) writeText(path.join(dir, "README.md"), "# Synthetic\nFixture context");
      writeJson(path.join(sources.ezcoder.taskProjects, String(n), "meta.json"), { path: dir, name: `p${n}` });
      writeJson(path.join(sources.ezcoder.taskProjects, String(n), "tasks.json"), [{ id: "ignored", title: "not imported", status: "pending" }]);
      links.push({ name: `p${n}`, cwd: dir });
      tasks.push({ project: `p${n}`, id: `t${n}`, title: n < 20 ? "needs your approval" : "ordinary task", status: "pending" });
    }
    writeJson(sources.ezboss.links, { projects: links });
    writeJson(sources.ezboss.plan, { tasks });
    const server = await buildServer(sources);
    try {
      const first = (await server.inject({ method: "POST", url: "/api/refresh" })).json<Portfolio>();
      expect(first.active).toHaveLength(12);
      expect(first.coverage).toMatchObject({ checked: 12, cached: 37, unavailable: 1, waitingOutsideCap: 8 });
      expect(first.inbox).toHaveLength(12);
      expect(first.other.every((p) => p.scanStatus !== "checked")).toBe(true);
      const hidden = first.active[0]!;
      await server.inject({ method: "POST", url: `/api/projects/${hidden.id}/override`, payload: { hidden: true } });
      writeText(sources.ezboss.plan, "{broken");
      const failed = (await server.inject({ method: "POST", url: "/api/refresh" })).json<Portfolio>();
      expect(failed.hidden.map((p) => p.id)).toContain(hidden.id);
      expect(failed.coverage!.unavailable).toBeGreaterThan(0);
      expect(failed.issues.length).toBeGreaterThan(0);
      expect(failed.history!.length).toBeGreaterThanOrEqual(12);
    } finally { await server.close(); }
  });
});

describe("optional controls", () => {
  it("pins a low-evidence project into Active on request", async () => {
    const quietId = (await portfolio()).other.find((x) => x.name === "quiet")!.id;
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${quietId}/override`,
      payload: { pinned: true },
    });
    expect(res.statusCode).toBe(200);
    const p = await portfolio();
    expect(p.active.map((x) => x.name)).toContain("quiet");
  });

  it("hides a project out of both views on request", async () => {
    const quietId = (await portfolio()).active.find((x) => x.name === "quiet")!.id;
    await app.inject({
      method: "POST",
      url: `/api/projects/${quietId}/override`,
      payload: { pinned: false, hidden: true },
    });
    const p = await portfolio();
    expect(p.active.map((x) => x.name)).not.toContain("quiet");
    expect(p.other.map((x) => x.name)).not.toContain("quiet");
    expect(p.hidden.map((x) => x.name)).toContain("quiet");
    await app.inject({
      method: "POST",
      url: `/api/projects/${quietId}/override`,
      payload: { hidden: false },
    });
  });

  it("keeps a corrected summary through later refreshes", async () => {
    const id = (await portfolio()).active.find((x) => x.name === "busy")!.id;
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${id}/summary`,
      payload: { recentFocus: "my own words" },
    });
    expect(res.statusCode).toBe(200);

    // Change the evidence: the correction must survive regeneration.
    writeJson(path.join(paths.ezcoder.taskProjects, "busy", "tasks.json"), [
      { id: "t9", title: "brand new task", status: "pending", updatedAt: iso(1) },
    ]);
    const p = await portfolio();
    const s = p.active.find((x) => x.name === "busy")!.summary;
    expect(s.recentFocus).toBe("my own words");
    expect(s.edited).toBe(true);
  });

  it("rejects a malformed override", async () => {
    const id = (await portfolio()).active[0]!.id;
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${id}/override`,
      payload: { pinned: "yes" },
    });
    expect(res.statusCode).toBe(400);
  });
});
