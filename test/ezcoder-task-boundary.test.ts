import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { ezcoderDiscovery } from "../src/adapters/discovery-ezcoder.ts";
import { readOnlyFs } from "../src/adapters/read-only-fs.ts";
import { canonicalPath } from "../src/core/canonical-path.ts";
import { sourcePaths } from "../src/shared/paths.ts";
import { openDb } from "../src/db/index.ts";
import { repo as makeRepo } from "../src/db/repo.ts";
import { refresh, withAttention } from "../src/model/refresh.ts";
import { collectDeliveryContext, planningProjectFacts } from "../src/model/delivery-context.ts";
import { summarize, summaryFingerprint } from "../src/model/summarize.ts";
import { registerRoutes } from "../src/server/routes.ts";
import type { Portfolio } from "../src/shared/types.ts";
import { emptyActivity, emptySummary } from "../src/shared/types.ts";
import { AT, NOW, project, task, tempDir, writeJson, writeText } from "./helpers.ts";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.realpathSync(tempDir("dave-task-boundary-"));
  roots.push(root);
  const paths = sourcePaths(path.join(root, "home"), path.join(root, "app"));
  const dirs = ["metadata", "workspace", "session"].map((name) => path.join(paths.home, "code", name));
  for (const dir of dirs) writeText(path.join(dir, "README.md"), "# Synthetic project\nA daily workflow.");
  // Workspace windows remain a hint; a real repository establishes project identity.
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dirs[1] });
  const meta = path.join(paths.ezcoder.taskProjects, "hash", "meta.json");
  writeJson(meta, { path: dirs[0], name: "metadata" });
  writeJson(paths.ezcoder.appWorkspace, { windows: [{ cwd: dirs[1] }] });
  writeText(path.join(paths.ezcoder.sessions, "synthetic", "2026-09-02T10-00-00Z_a.jsonl"), JSON.stringify({ cwd: dirs[2] }) + "\n");
  const denied = [path.join(paths.home, ".ezcoder", "projects.json"), path.join(path.dirname(meta), "tasks.json")];
  for (const file of denied) writeText(file, "DENIED SENTINEL: not valid JSON");
  return { paths, dirs, meta, denied };
}

/** Record attempted calls before application catches can swallow failures. */
function watchReads() {
  const attempted: string[] = [];
  const opened: string[] = [];
  const check = (value: unknown) => {
    const file = value instanceof URL ? value.pathname : String(value);
    if (["tasks.json", "projects.json"].includes(path.basename(file))) {
      attempted.push(file);
      throw new Error("Denied synthetic file access");
    }
    opened.push(file);
  };
  for (const name of ["readText", "readHead"] as const) {
    const original = readOnlyFs[name].bind(readOnlyFs);
    vi.spyOn(readOnlyFs, name).mockImplementation(async (p: string, bytes?: number) => {
      check(p); return original(p, bytes ?? 1024);
    });
  }
  const readFile = fsp.readFile.bind(fsp), open = fsp.open.bind(fsp);
  vi.spyOn(fsp, "readFile").mockImplementation((...args: Parameters<typeof fsp.readFile>) => { check(args[0]); return readFile(...args); });
  vi.spyOn(fsp, "open").mockImplementation((...args: Parameters<typeof fsp.open>) => { check(args[0]); return open(...args); });
  const readFileSync = fs.readFileSync.bind(fs), openSync = fs.openSync.bind(fs);
  vi.spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof fs.readFileSync>) => { check(args[0]); return readFileSync(...args); });
  vi.spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => { check(args[0]); return openSync(...args); });
  return { attempted, opened };
}

const all = (p: Portfolio) => [...p.active, ...p.other, ...p.hidden];

describe("EZ Coder file boundary", () => {
  it("never attempts denied files during cold discovery, fresh/cached refresh or local planning facts", async () => {
    const { paths, dirs, meta } = fixture();
    const db = openDb(paths.appHome), repo = makeRepo(db);
    const { attempted, opened } = watchReads();
    try {
      const discovered = await ezcoderDiscovery(paths).discover();
      expect(discovered.issues).toEqual([]);
      expect(discovered.data.map((p) => p.rawPath)).toEqual(expect.arrayContaining(dirs));
      expect(opened).toContain(meta);
      expect(opened).toContain(paths.ezcoder.appWorkspace);
      expect(opened.some((p) => p.endsWith("_a.jsonl"))).toBe(true);
      expect(attempted).toEqual([]);
      const fresh = await refresh(paths, repo, NOW);
      expect(all(fresh)).toHaveLength(3);
      expect(all(fresh).find((p) => p.name === "session")?.activity.sessionCount).toBe(1);
      expect(all(fresh).every((p) => p.tasks.length === 0)).toBe(true);
      expect(attempted).toEqual([]);
      const cached = await refresh(paths, repo, NOW);
      const before = opened.length;
      for (const p of all(cached)) expect(planningProjectFacts(p)).not.toHaveProperty("tasks");
      expect(opened).toHaveLength(before); // planning seed has no file-reading capability
      for (const p of all(cached)) {
        const packet = await collectDeliveryContext({ project: p,
          goal: { goal: "Daily workflow", intendedUser: "User", workflow: "Work", stage: "Unknown", provider: null, model: null, consent: null },
          provider: "openai", model: "gpt-6-astra",
          permissions: { collect: true, categories: ["documents", "manifest", "entrypoints", "coverage", "history"], documents: ["README.md"] } });
        expect(JSON.stringify(packet)).not.toMatch(/LEGACY TASK|DENIED SENTINEL|ezcoder-task/);
        for (const name of ["tasks.json", "projects.json", ".ezcoder/tasks.json"]) {
          await expect(collectDeliveryContext({ project: p,
            goal: { goal: "", intendedUser: "", workflow: "", stage: "", provider: null, model: null, consent: null },
            provider: "openai", model: "gpt-6-astra",
            permissions: { collect: true, categories: ["documents"], documents: [name] } })).rejects.toThrow();
        }
      }
      expect(attempted).toEqual([]);

      // Exercise actual HTTP failed-refresh fallback, not just the projection helper.
      const app = Fastify();
      registerRoutes(app, paths, repo, { clock: () => NOW, refresh: async () => { throw new Error("synthetic unavailable source"); } });
      try {
        const response = await app.inject("/api/portfolio");
        expect(response.statusCode).toBe(200);
        expect(response.json().stale).toBe(true);
        expect(all(response.json())).toHaveLength(3);
        expect(attempted).toEqual([]);
      } finally { await app.close(); }
    } finally { db.close(); }
  });

  it("filters old snapshots and attention without altering stored rows or manual text", async () => {
    const { paths, dirs } = fixture();
    const db = openDb(paths.appHome), repo = makeRepo(db);
    try {
      const id = repo.ensureProject(canonicalPath(dirs[0]!), "metadata", AT);
      const legacyTask = task({ source: "ezcoder-tasks", title: "needs your approval for LEGACY TASK" });
      const evidence = [{ kind: "ezcoder-task" as const, path: null, detail: "LEGACY TASK", observedAt: AT }];
      const summary = { ...emptySummary(AT), recentFocus: "LEGACY TASK", completed: "LEGACY TASK", evidence };
      repo.saveSummary(id, "old-policy", summary);
      const p = project({ id, canonicalPath: dirs[0]!, tasks: [legacyTask], summary,
        activity: { ...emptyActivity(), openTaskCount: 1, lastTaskUpdateAt: AT, lastTechnicalActivityAt: AT },
        relevance: { score: 999, tier: "active", reasons: [{ code: "human-request", points: 999, detail: "LEGACY TASK" }] } });
      repo.reconcileAttention([{ projectId: id, subjectKey: '["ezcoder-tasks","t1"]', fingerprint: "legacy",
        kind: "agent-question", title: "LEGACY TASK", detail: "LEGACY TASK", evidence, urgency: 100, nextStep: "LEGACY TASK" }], [], AT);
      const snapshot: Portfolio = { generatedAt: AT, active: [p], other: [], hidden: [], inbox: repo.inbox(NOW), today: [], issues: [] };
      repo.saveSnapshot(snapshot);
      const rows = repo.inbox(NOW, true);
      const clean = withAttention(snapshot, repo, NOW);
      expect(JSON.stringify(clean)).not.toContain("LEGACY TASK");
      expect(clean.active).toEqual([]);
      expect(clean.other[0]?.activity).toMatchObject({ openTaskCount: 0, lastTaskUpdateAt: null, lastTechnicalActivityAt: null });
      expect(repo.latest()).toEqual(snapshot);
      expect(repo.summary(id)?.summary).toEqual(summary);
      const app = Fastify();
      registerRoutes(app, paths, repo, { clock: () => NOW, refresh: async () => { throw new Error("offline"); } });
      try {
        const response = await app.inject("/api/portfolio");
        expect(response.statusCode).toBe(200);
        expect(response.json().stale).toBe(true);
        expect(JSON.stringify(response.json())).not.toContain("LEGACY TASK");
        expect(response.json().inbox).toEqual([]);
        expect(response.json().history).toEqual([]);
        expect(response.json().newCount).toBe(0);
        expect(response.json().remainingCount).toBe(0);
      } finally { await app.close(); }
      const manual = { ...summary, edited: true, suggestedNextAction: "My exact LEGACY TASK notes\nDo not contact clients." };
      repo.saveSummary(id, "manual-old-policy", manual);
      const { attempted } = watchReads();
      const refreshed = await refresh(paths, repo, NOW);
      expect(all(refreshed).find((p) => p.id === id)?.summary.suggestedNextAction).toBe(manual.suggestedNextAction);
      expect(repo.summary(id)?.summary).toEqual(manual);
      expect(repo.inbox(NOW, true)).toEqual(rows);
      const facts = planningProjectFacts(all(refreshed).find((p) => p.id === id)!);
      expect(JSON.stringify(facts)).not.toMatch(/LEGACY TASK|Do not contact|ezcoder-task/);
      const packet = await collectDeliveryContext({ project: all(refreshed).find((p) => p.id === id)!,
        goal: { goal: "Daily work", intendedUser: "", workflow: "", stage: "", provider: null, model: null, consent: null },
        provider: "openai", model: "gpt-6-astra",
        permissions: { collect: true, categories: ["goal", "documents", "coverage", "history"], documents: ["README.md"] } });
      expect(JSON.stringify(packet)).not.toMatch(/LEGACY TASK|Do not contact|ezcoder-task/);
      expect(repo.summary(id)?.summary).toEqual(manual);
      expect(attempted).toEqual([]);

      // Missing discovery and generated legacy summaries cannot reappear from old snapshots.
      repo.saveSummary(id, "old-policy", summary);
      fs.renameSync(paths.home, paths.home + "-offline");
      const unavailable = await refresh(paths, repo, NOW);
      expect(JSON.stringify(unavailable)).not.toContain("LEGACY TASK");
      expect(all(unavailable).find((p) => p.id === id)?.scanStatus).toBe("unavailable");
      expect(repo.summary(id)?.summary).toEqual(summary);
      expect(attempted).toEqual([]);
    } finally { db.close(); }
  });

  it("regenerates pinned generated summaries under the new policy without task input", async () => {
    const { paths, dirs } = fixture();
    const db = openDb(paths.appHome), repo = makeRepo(db);
    try {
      const id = repo.ensureProject(canonicalPath(dirs[0]!), "metadata", AT);
      repo.saveSummary(id, "old-policy", { ...emptySummary(AT), recentFocus: "LEGACY TASK" });
      repo.setOverride(id, { pinned: true }, AT);
      const { attempted } = watchReads();
      const current = await refresh(paths, repo, NOW);
      expect(current.active.find((p) => p.id === id)?.summary.recentFocus).toBeNull();
      expect(repo.summary(id)?.fingerprint).toMatch(/^attention-v5:no-ezcoder-tasks:/);
      expect(attempted).toEqual([]);
    } finally { db.close(); }
  });

  it("does not mine any agent list or manual note into planning facts", () => {
    const p = project({ tasks: [task({ source: "ezboss-plan", title: "PRIVATE TASK" })],
      summary: { ...emptySummary(AT), edited: true, recentFocus: "PRIVATE NOTE" } });
    expect(planningProjectFacts(p)).toEqual({ projectId: p.id, name: p.name, canonicalPath: p.canonicalPath, exists: true, scanStatus: "unavailable" });
  });

  it("ignores EZ Coder task changes in summary content and policy fingerprints", () => {
    const input = { projectName: "test", activity: emptyActivity(), tasks: [], docs: [], sessions: [], observedAt: AT };
    const contaminated = { ...input, tasks: [task({ source: "ezcoder-tasks", status: "done", title: "PRIVATE TASK" })] };
    expect(summarize(contaminated)).toEqual(summarize(input));
    expect(summaryFingerprint(contaminated)).toBe(summaryFingerprint(input));
    expect(summaryFingerprint(input)).toMatch(/^attention-v5:no-ezcoder-tasks:/);
  });

  it("refuses direct and symlinked task/credential files before an OS open", async () => {
    const { dirs, denied } = fixture();
    const open = vi.spyOn(fsp, "open"), read = vi.spyOn(fsp, "readFile");
    for (const [i, file] of denied.entries()) {
      const alias = path.join(dirs[0]!, `README-${i}.md`);
      fs.symlinkSync(file, alias);
      for (const target of [file, alias]) {
        await expect(readOnlyFs.readText(target)).rejects.toThrow("deny-listed");
        await expect(readOnlyFs.readHead(target, 100)).rejects.toThrow("deny-listed");
      }
    }
    expect(open).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});
