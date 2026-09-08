import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db/index.ts";
import { repo as makeRepo } from "../src/db/repo.ts";
import { emptyActivity, emptySummary } from "../src/shared/types.ts";
import type { AgentTask, PortfolioProject } from "../src/shared/types.ts";
import type { Repo } from "../src/db/repo.ts";

export const NOW = new Date("2026-09-02T12:00:00.000Z");
export const AT = NOW.toISOString();

/** ISO timestamp `hours` before NOW. */
export const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

export function tempDir(prefix = "pcc-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

export function writeText(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

export function freshRepo(): { home: string; repo: Repo } {
  const home = tempDir("pcc-db-");
  return { home, repo: makeRepo(openDb(home)) };
}

export function task(over: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "t1",
    title: "a task",
    status: "pending",
    summary: null,
    updatedAt: AT,
    source: "ezcoder-tasks",
    ...over,
  };
}

export function project(over: Partial<PortfolioProject> = {}): PortfolioProject {
  return {
    id: "p1",
    canonicalPath: "/p/one",
    name: "one",
    exists: true,
    signals: ["git-repo"],
    aliases: [],
    sources: ["ezboss-links"],
    activity: emptyActivity(),
    tasks: [],
    sessionDir: null,
    relevance: { score: 0, reasons: [], tier: "other" },
    summary: emptySummary(AT),
    override: { pinned: false, hidden: false },
    ...over,
  };
}
