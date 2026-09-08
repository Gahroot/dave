import path from "node:path";
import os from "node:os";
import { canonicalPath, pathExists } from "../core/canonical-path.ts";
import { detectProjects, signalForSource } from "../core/detect.ts";
import { scoreRelevance, selectActive } from "../core/relevance.ts";
import { scanProjectEvidence } from "../core/evidence-scan.ts";
import { readSessionSummaries } from "../adapters/session-summary.ts";
import { recentCommitSubjects } from "../adapters/git.ts";
import { summarize, summaryFingerprint } from "./summarize.ts";
import { ok } from "../core/result.ts";
import type { Result } from "../core/result.ts";
import { emptyActivity, emptySummary } from "../shared/types.ts";
import type {
  AgentTask,
  PortfolioIssue,
  PortfolioProject,
  TechnicalActivity,
} from "../shared/types.ts";
import type { AgentActivity, AgentStateAdapter, DiscoveryAdapter, GitAdapter } from "../adapters/types.ts";
import type { Repo } from "../db/repo.ts";

export type BuildInput = {
  discovery: DiscoveryAdapter[];
  agent: AgentStateAdapter;
  git: GitAdapter;
  repo: Repo;
  home?: string;
  now?: Date;
  /** How many top-ranked projects get a full evidence scan. */
  summarizeLimit?: number;
};

function newest(values: (string | null)[]): string | null {
  const valid = values.filter((v): v is string => !!v && !Number.isNaN(Date.parse(v)));
  return valid.length ? valid.sort().at(-1)! : null;
}

/**
 * Builds the whole portfolio with zero user input: discover, keep directories
 * with real project evidence, rank by evidence of current relevance, then
 * summarize the ones that matter. Summaries are reused unless their underlying
 * evidence changed.
 */
export async function buildPortfolio(input: BuildInput): Promise<Result<PortfolioProject[]>> {
  const now = input.now ?? new Date();
  const home = input.home ?? os.homedir();
  const observedAt = now.toISOString();
  const issues: PortfolioIssue[] = [];

  const signals = new Map<string, Set<import("../shared/types.ts").DetectionSignal>>();
  const sources = new Map<string, Set<string>>();
  const names = new Map<string, string>();
  const raw = new Map<string, { path: string; source: string }[]>();

  for (const adapter of input.discovery) {
    let found;
    try {
      found = await adapter.discover();
    } catch (e) {
      issues.push({
        adapter: adapter.name,
        path: null,
        message: e instanceof Error ? e.message : String(e),
        observedAt,
      });
      continue;
    }
    issues.push(...found.issues);
    for (const p of found.data) {
      const key = canonicalPath(p.rawPath);
      if (!signals.has(key)) {
        signals.set(key, new Set());
        sources.set(key, new Set());
        raw.set(key, []);
      }
      const signal = signalForSource(p.source);
      if (signal) signals.get(key)!.add(signal);
      sources.get(key)!.add(p.source);
      raw.get(key)!.push({ path: p.rawPath, source: p.source });
      if (p.name && !names.has(key)) names.set(key, p.name);
    }
  }

  const { accepted } = detectProjects(signals, home);

  let agentState = new Map<string, { tasks: AgentTask[]; activity: AgentActivity }>();
  try {
    const r = await input.agent.read();
    issues.push(...r.issues);
    agentState = r.data as typeof agentState;
  } catch (e) {
    issues.push({
      adapter: input.agent.name,
      path: null,
      message: e instanceof Error ? e.message : String(e),
      observedAt,
    });
  }

  // simplification: any discovery/task error prevents absence-based reconciliation
  // across this scan; per-source coverage can narrow this conservative boundary later.
  const tasksObserved = issues.length === 0;

  // Pass 1: cheap facts for every project, enough to rank them.
  type Draft = {
    id: string;
    canonical: string;
    name: string;
    exists: boolean;
    available: boolean;
    activity: TechnicalActivity;
    tasks: AgentTask[];
    sessionDir: string | null;
  };
  const drafts: Draft[] = [];

  for (const candidate of accepted) {
    const canonical = candidate.canonicalPath;
    const name = names.get(canonical) ?? path.basename(canonical);
    const id = input.repo.ensureProject(canonical, name, observedAt);
    for (const r of raw.get(canonical) ?? []) {
      input.repo.recordAlias(id, r.path, r.source, observedAt);
    }
    input.repo.recordSignals(id, candidate.signals);

    const exists = pathExists(canonical);
    const state = agentState.get(canonical);
    const tasks = state?.tasks ?? [];

    const activity = emptyActivity();
    activity.lastAgentSessionAt = state?.activity.lastActivityAt ?? null;
    activity.sessionCount = state?.activity.sessionCount ?? 0;
    activity.activeDayCount = state?.activity.activeDays ?? 0;
    activity.openTaskCount = tasks.filter(
      (t) => t.status === "pending" || t.status === "in_progress",
    ).length;
    activity.runningTaskCount = tasks.filter((t) => t.status === "in_progress").length;
    activity.blockedTaskCount = tasks.filter((t) => t.status === "blocked").length;
    activity.doneTaskCount = tasks.filter((t) => t.status === "done").length;
    activity.lastTaskUpdateAt = newest(tasks.map((t) => t.updatedAt));

    let available = exists && tasksObserved;
    if (exists) {
      const g = await input.git.read(canonical);
      issues.push(...g.issues);
      if (g.issues.length) available = false;
      if (g.data) {
        activity.branch = g.data.branch;
        activity.dirty = g.data.dirty;
        activity.dirtyFileCount = g.data.dirtyFileCount;
        activity.lastCommitAt = g.data.lastCommitAt;
        activity.lastCommitSubject = g.data.lastCommitSubject;
      }
    }
    activity.lastTechnicalActivityAt = newest([
      activity.lastCommitAt,
      activity.lastAgentSessionAt,
      activity.lastTaskUpdateAt,
    ]);

    drafts.push({
      id,
      canonical,
      name,
      exists,
      available,
      activity,
      tasks,
      sessionDir: state?.activity.sessionDir ?? null,
    });
  }

  // Pass 2: rank, then deep-scan only the projects that look live.
  const ranked = drafts
    .map((d) => ({ draft: d, override: input.repo.override(d.id) }))
    .map((r) => ({
      ...r,
      relevance: scoreRelevance(r.draft.activity, r.draft.tasks, r.override, now),
    }))
    .sort((a, b) => b.relevance.score - a.relevance.score || a.draft.name.localeCompare(b.draft.name));

  const toSummarize = new Set(selectActive(ranked.map((r) => ({
    ...r.draft, override: r.override, relevance: r.relevance,
  })), input.summarizeLimit).map((r) => r.id));

  const projects: PortfolioProject[] = [];
  for (const { draft, override, relevance } of ranked) {
    let summary = input.repo.summary(draft.id)?.summary ?? emptySummary(observedAt);

    let scanStatus: PortfolioProject["scanStatus"] = draft.available ? "cached" : "unavailable";
    if (toSummarize.has(draft.id) && draft.exists) {
      const sessionResult = draft.sessionDir ? await readSessionSummaries(draft.sessionDir) : ok([]);
      const docsResult = await scanProjectEvidence(draft.canonical, observedAt);
      issues.push(...sessionResult.issues, ...docsResult.issues);
      const sessions = sessionResult.data;
      const docs = docsResult.data.files;
      scanStatus = draft.available && !sessionResult.issues.length && !docsResult.issues.length ? "checked" : "unavailable";
      if (draft.exists) {
        draft.activity.recentCommitSubjects = await recentCommitSubjects(draft.canonical);
      }
      const summaryInput = {
        projectName: draft.name,
        activity: draft.activity,
        tasks: draft.tasks,
        sessions,
        docs,
        observedAt,
      };
      const fingerprint = summaryFingerprint(summaryInput);
      const cached = input.repo.summary(draft.id);
      // Regenerate only when the evidence changed, and never overwrite a
      // summary the user corrected by hand.
      if (cached?.fingerprint === fingerprint || cached?.summary.edited) {
        summary = cached.summary;
      } else {
        summary = summarize(summaryInput);
        input.repo.saveSummary(draft.id, fingerprint, summary);
      }
    }

    projects.push({
      id: draft.id,
      canonicalPath: draft.canonical,
      name: draft.name,
      exists: draft.exists,
      scanStatus,
      tasksObserved,
      signals: input.repo.signals(draft.id),
      aliases: input.repo.aliases(draft.id),
      sources: [...(sources.get(draft.canonical) ?? [])].sort(),
      activity: draft.activity,
      tasks: draft.tasks,
      sessionDir: draft.sessionDir,
      relevance,
      summary,
      override,
    });
  }

  const latest = input.repo.latest();
  const known = new Set(projects.map((p) => p.id));
  for (const old of [...(latest?.active ?? []), ...(latest?.other ?? []), ...(latest?.hidden ?? [])]) {
    if (!known.has(old.id)) projects.push({ ...old, exists: pathExists(old.canonicalPath),
      scanStatus: "unavailable", tasksObserved: false, relevance: { ...old.relevance, tier: "other" }, override: input.repo.override(old.id) });
  }
  return ok(projects, issues);
}
