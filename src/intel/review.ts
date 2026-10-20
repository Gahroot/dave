/**
 * Pure review over ledger rows: how DAVE's picks compared with what the owner did. Deterministic (sorted iteration,
 * injected now). Suggestions are offers only; the owner applies them through the review route.
 */
import { LEDGER_OUTCOMES, type LedgerOutcome, type LedgerRow, type ReviewReport, type ReviewSuggestion } from "./ledger-types.ts";

const OVERRIDES_SHOWN = 20;
const SUGGEST_MIN_OVERRIDES = 3;
const PATTERN_MIN = 2;

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const times = (n: number): string => (n === 1 ? "once" : `${n} times`);
/** Plain words for objective categories and prepared-action kinds; patterns are read on screen and spoken by Pew. */
const KIND_WORDS: Readonly<Record<string, string>> = {
  coding: "build", investigation: "investigate", client_action: "client follow-up", access_configuration: "access or configuration",
  testing: "testing", deployment: "deployment", training: "training", approval: "approval",
  build: "build", verify: "check it", decide: "decide", chase: "chase", follow_up: "follow-up", demo: "client demo", step: "next step",
  target_date: "target date", confirm_finish_line: "confirm the finish line", retry: "retry",
};
const kindWords = (kind: string): string => KIND_WORDS[kind] ?? kind.replace(/_/g, " ");

/** The owner's current direction for a project: its priority and when direction was last changed (null = never). */
export type ReviewDirection = { priority: number | null; updatedAt: string | null };

export function buildReview(rows: LedgerRow[], opts: { days: number; now: Date; projectName: (id: string) => string | null; currentDirection?: (projectId: string) => ReviewDirection | null }): ReviewReport {
  const name = (id: string | null): string => (id ? opts.projectName(id) ?? id : "another project");
  const sorted = [...rows].sort((a, b) => byText(a.recommendedAt, b.recommendedAt) || byText(a.id, b.id));
  const totals = { open: 0, ...Object.fromEntries(LEDGER_OUTCOMES.map((o) => [o, 0])) } as Record<LedgerOutcome | "open", number>;
  for (const r of sorted) totals[r.outcome ?? "open"] += 1;
  const denom = totals.followed + totals.overridden + totals.skipped;
  const agreementRate = denom === 0 ? null : Math.round((totals.followed / denom) * 1000) / 1000;

  const resolved = sorted.filter((r) => r.outcome !== null);
  const kinds = new Map<string, { followed: number; skipped: number; total: number }>();
  for (const r of resolved) {
    const k = kinds.get(r.actionKind) ?? { followed: 0, skipped: 0, total: 0 };
    k.total += 1; if (r.outcome === "followed") k.followed += 1; if (r.outcome === "skipped") k.skipped += 1;
    kinds.set(r.actionKind, k);
  }
  const byKind = [...kinds.entries()].sort(([a], [b]) => byText(a, b)).map(([kind, k]) => ({ kind, followed: k.followed, total: k.total }));

  const projects = new Map<string, { followed: number; overridden: number; total: number }>();
  for (const r of resolved) {
    if (r.scope !== "project" || !r.projectId) continue;
    const p = projects.get(r.projectId) ?? { followed: 0, overridden: 0, total: 0 };
    p.total += 1; if (r.outcome === "followed") p.followed += 1; if (r.outcome === "overridden") p.overridden += 1;
    projects.set(r.projectId, p);
  }
  const byProject = [...projects.entries()].sort(([a], [b]) => byText(a, b)).map(([projectId, p]) => ({ projectId, projectName: name(projectId), ...p }));

  const overrides = resolved
    .filter((r) => r.outcome === "overridden" || r.outcome === "skipped" || r.outcome === "deferred")
    .sort((a, b) => byText(b.outcomeAt ?? b.recommendedAt, a.outcomeAt ?? a.recommendedAt) || byText(a.id, b.id))
    .slice(0, OVERRIDES_SHOWN)
    .map((r) => ({
      recommended: r.projectId ? `${name(r.projectId)}: ${r.title}` : r.title,
      actual: r.outcome === "overridden" ? r.actualTitle ?? (r.actualProjectId ? name(r.actualProjectId) : null) : r.outcome === "deferred" ? "Deferred" : "Skipped",
      reason: r.note, basis: r.outcomeBasis, at: r.outcomeAt ?? r.recommendedAt,
    }));

  const patterns: string[] = [];
  for (const [kind, k] of [...kinds.entries()].sort(([a], [b]) => byText(a, b))) {
    if (k.skipped >= PATTERN_MIN && k.skipped * 2 >= k.total) patterns.push(`You skipped ${k.skipped} of ${k.total} ${kindWords(kind)} recommendations`);
  }
  // Overrides toward another project, counted once per event (global and project rows can both record the same one).
  // Each event keeps its latest time so suggestions can ignore overrides the owner already acted on.
  const toward = new Map<string, Map<string, string>>();
  for (const r of resolved) {
    if (r.outcome !== "overridden" || !r.actualProjectId || r.actualProjectId === r.projectId) continue;
    const events = toward.get(r.actualProjectId) ?? new Map<string, string>();
    const ref = r.actualRef ?? r.id, at = r.outcomeAt ?? r.recommendedAt, seen = events.get(ref);
    events.set(ref, seen && seen > at ? seen : at);
    toward.set(r.actualProjectId, events);
  }
  const towardSorted = [...toward.entries()].map(([id, events]) => ({ id, n: events.size, ats: [...events.values()] })).sort((a, b) => b.n - a.n || byText(a.id, b.id));
  for (const t of towardSorted) if (t.n >= PATTERN_MIN) patterns.push(`You worked on ${name(t.id)} instead of DAVE's pick ${times(t.n)}`);
  for (const [projectId, p] of byProject.map((b) => [b.projectId, b] as const)) {
    const inside = resolved.filter((r) => r.scope === "project" && r.projectId === projectId && r.outcome === "overridden" && r.actualProjectId === projectId).length;
    if (inside >= PATTERN_MIN) patterns.push(`In ${p.projectName}, you worked on other items instead of DAVE's pick ${times(inside)}`);
  }

  const suggestions: ReviewSuggestion[] = [];
  for (const t of towardSorted) {
    // Only overrides after the owner last changed this project's direction count, so applying a suggestion (or
    // setting the priority by hand) uses up the evidence behind it instead of prompting another bump on the same history.
    const dir = opts.currentDirection?.(t.id) ?? null;
    const since = dir?.updatedAt ?? null;
    const fresh = since ? t.ats.filter((at) => at > since).length : t.n;
    if (fresh < SUGGEST_MIN_OVERRIDES) continue;
    const cur = dir?.priority ?? null;
    if (cur === 1) continue;
    const priority = cur === null ? 2 : cur - 1;
    suggestions.push({
      id: `set_priority:${t.id}:${priority}`,
      text: `Set ${name(t.id)} to priority ${priority} (1 is most important): you chose it over DAVE's pick ${times(fresh)}${since ? " since you last changed its direction" : ""}`,
      op: { op: "set_priority", projectId: t.id, priority },
    });
  }
  return { days: opts.days, totals, agreementRate, byKind, byProject, overrides, patterns, suggestions };
}
