import type { Db } from "../db/index.ts";
import type { IntelService } from "../intel/service.ts";
import { hash } from "../intel/store.ts";
import type { IntelItem, Objective } from "../intel/types.ts";
import type { SourcePaths } from "../shared/paths.ts";
import { assessProgress } from "./assess.ts";
import { scanEzcoderRuns } from "./ezcoder-runs.ts";
import { scanGit, type RunGitFn } from "./git-events.ts";
import { defaultRunGh, scanGithub, type RunGhFn } from "./github.ts";
import { linkEvent } from "./link.ts";
import {
  getCursor, hasEvent, insertEvent, readEvents, readHealth, readProgress, readSettings, readWorkEvidence, setCursor, writeHealth, writeProgress, writeSettings,
  type WorkQuery,
} from "./store.ts";
import type { NewWorkEvent, ProgressReport, WorkEvent, WorkEvidence, WorkPollResult, WorkSettingsView, WorkSourceHealth } from "./types.ts";
import { projectForCwd, type WorkProject } from "./worktree.ts";

export const POLL_MS = 60_000;
export const GITHUB_EVERY_MS = 10 * 60_000;

export type WorkServiceOptions = {
  db: Db;
  paths: SourcePaths;
  intel: Pick<IntelService, "reconcile" | "store" | "projectIntel">;
  /** Active, non-hidden projects. */
  projects: () => WorkProject[];
  now?: () => Date;
  runGh?: RunGhFn;
  runGitFn?: RunGitFn;
  /** Test override for the EZ Coder sessions folder. */
  ezcoderSessionsDir?: string;
};

export type WorkService = {
  poll(signal?: AbortSignal): Promise<WorkPollResult>;
  workEvidence(projectId: string): WorkEvidence[];
  progress(query: WorkQuery): ProgressReport[];
  events(query: WorkQuery): WorkEvent[];
  settings(): WorkSettingsView;
  setSettings(input: { github: boolean }): WorkSettingsView;
  onProgress(listener: (r: ProgressReport) => void): () => void;
  start(): void;
  close(): void;
};

/**
 * The completion loop: watches EZ Coder runs, local commits and (opt-in) merged PRs, links each to the plan, lets
 * intel reconcile, and writes a progress report per event. It only reads and records; it never starts work.
 */
export function createWorkService(opts: WorkServiceOptions): WorkService {
  const { db } = opts;
  const now = opts.now ?? (() => new Date());
  const paths: SourcePaths = opts.ezcoderSessionsDir ? { ...opts.paths, ezcoder: { ...opts.paths.ezcoder, sessions: opts.ezcoderSessionsDir } } : opts.paths;
  const runGh = opts.runGh ?? defaultRunGh;
  const listeners = new Set<(r: ProgressReport) => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<WorkPollResult> | null = null;
  let controller: AbortController | null = null;

  const health = (h: WorkSourceHealth): void => writeHealth(db, h, h.lastRunAt ?? now().toISOString());

  function objectives(projectId: string): Objective[] {
    try {
      const pi = opts.intel.projectIntel(projectId);
      return [...(pi.objective ? [pi.objective] : []), ...pi.otherActions];
    } catch { return []; }
  }
  const brief = (o: Objective | undefined): { id: string; title: string } | null => (o ? { id: o.id, title: o.objective } : null);
  const items = (projectId: string): IntelItem[] => { try { return opts.intel.store.items(projectId); } catch { return []; } };

  async function collect(projects: WorkProject[], at: string, signal?: AbortSignal): Promise<NewWorkEvent[]> {
    const out: NewWorkEvent[] = [];
    try {
      for (const r of await scanEzcoderRuns(db, paths, at, signal)) {
        const p = await projectForCwd(r.cwd, projects, paths.home);
        if (!p) continue;
        out.push({ projectId: p.id, source: "ezcoder", ref: `${r.sessionId}:${r.generation}`, kind: "run_finished", outcome: r.outcome, title: r.title, summary: r.summary, at: r.at, marker: r.marker });
      }
      health({ source: "ezcoder", state: "ok", lastRunAt: at, detail: null });
    } catch (e) {
      if (signal?.aborted) throw e;
      health({ source: "ezcoder", state: "degraded", lastRunAt: at, detail: "Could not read EZ Coder sessions" });
    }
    try {
      const g = await scanGit(db, projects, at, opts.runGitFn, signal);
      out.push(...g.events);
      health({ source: "git", state: g.failures ? "degraded" : "ok", lastRunAt: at, detail: g.failures ? `${g.failures} project(s) could not be read` : null });
    } catch (e) {
      if (signal?.aborted) throw e;
      health({ source: "git", state: "degraded", lastRunAt: at, detail: "Could not read local git history" });
    }
    if (readSettings(db).githubEnabled) {
      const last = getCursor(db, "github-run", "last");
      if (!last || now().getTime() - Date.parse(last) >= GITHUB_EVERY_MS) {
        setCursor(db, "github-run", "last", at, at);
        try {
          const g = await scanGithub(db, projects, at, runGh, signal);
          out.push(...g.events);
          health({ source: "github", state: g.failures ? "degraded" : "ok", lastRunAt: at, detail: g.failures ? (g.error ?? "gh failed") : g.checked ? null : "No GitHub projects found" });
        } catch {
          health({ source: "github", state: "degraded", lastRunAt: at, detail: "Could not check GitHub" });
        }
      }
    }
    return out;
  }

  async function pollOnce(signal?: AbortSignal): Promise<WorkPollResult> {
    const at = now().toISOString();
    const projects = opts.projects();
    const names = new Map(projects.map((p) => [p.id, p.name]));
    const found = await collect(projects, at, signal);
    const byProject = new Map<string, { id: string; e: NewWorkEvent }[]>();
    const seen = new Set<string>();
    for (const e of found) {
      const id = hash("work", e.source, e.projectId, e.ref);
      if (seen.has(id) || hasEvent(db, id)) continue;
      seen.add(id);
      byProject.set(e.projectId, [...(byProject.get(e.projectId) ?? []), { id, e }]);
    }
    let events = 0, reports = 0;
    for (const projectId of [...byProject.keys()].sort()) {
      const list = (byProject.get(projectId) ?? []).sort((a, b) => a.e.at.localeCompare(b.e.at) || a.id.localeCompare(b.id));
      const before = items(projectId);
      const objs = objectives(projectId);
      const nextBefore = brief(objs[0]);
      const stored: WorkEvent[] = [];
      for (const { id, e } of list) {
        const l = linkEvent(db, e, before, objs);
        const ev: WorkEvent = { id, projectId, source: e.source, ref: e.ref, kind: e.kind, outcome: e.outcome, title: e.title, summary: e.summary, at: e.at,
          objectiveId: l.objectiveId, itemIds: l.itemIds, link: l.link, observedAt: at };
        if (insertEvent(db, ev)) { stored.push(ev); events++; }
      }
      if (!stored.length) continue;
      try { await opts.intel.reconcile(projectId); } catch { /* reconcile failures leave the plan as it was */ }
      const after = items(projectId);
      let plan: { steps: Record<"production_ready" | "live" | "using" | "signed_off", boolean> } | null = null;
      let nextAfter: { id: string; title: string } | null = null;
      try { const pi = opts.intel.projectIntel(projectId); plan = pi.plan.progress; nextAfter = brief(pi.objective ?? undefined); } catch { plan = null; }
      for (const ev of stored) {
        const report = assessProgress({ event: ev, projectName: names.get(projectId) ?? projectId, before, after, plan, nextBefore, nextAfter });
        writeProgress(db, report);
        reports++;
        for (const fn of [...listeners]) { try { fn(report); } catch { /* listeners never break the loop */ } }
      }
    }
    return { events, reports, projects: [...byProject.keys()].length };
  }

  function poll(signal?: AbortSignal): Promise<WorkPollResult> {
    running ??= pollOnce(signal).finally(() => { running = null; });
    return running;
  }

  function settings(): WorkSettingsView {
    const s = readSettings(db);
    const github: WorkSourceHealth = s.githubEnabled ? readHealth(db, "github") : { source: "github", state: "off", lastRunAt: readHealth(db, "github").lastRunAt, detail: "Switched off in Connections" };
    return { ...s, sources: [readHealth(db, "ezcoder"), readHealth(db, "git"), github] };
  }

  return {
    poll,
    workEvidence: (projectId) => readWorkEvidence(db, projectId, now()),
    progress: (q) => readProgress(db, q),
    events: (q) => readEvents(db, q),
    settings,
    setSettings: ({ github }) => { writeSettings(db, github, now().toISOString()); return settings(); },
    onProgress: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    start() {
      if (timer) return;
      controller = new AbortController();
      const ac = controller;
      timer = setInterval(() => { void poll(ac.signal).catch(() => undefined); }, POLL_MS);
      timer.unref();
    },
    close() {
      if (timer) { clearInterval(timer); timer = null; }
      controller?.abort();
      controller = null;
    },
  };
}
