/**
 * Recommendation ledger contract: every recommendation DAVE made, how it was resolved, and the review that compares
 * DAVE's picks with what the owner actually did. Type-only plus constants: no Node imports, so the browser bundle can
 * import it.
 *
 * The review only suggests direction changes; the owner applies them. DAVE never applies a suggestion by itself.
 *
 * Routes (loopback CSRF/origin guard):
 *  GET  /api/intel/recommendations/review?days=30 (7..90)   -> ReviewReport
 *  POST /api/intel/recommendations/suggestions/apply {id}   -> {applied: true, report: ReviewReport} | 409 when stale
 */
import type { Objective } from "./types.ts";
import type { PreparedOpName } from "./next-types.ts";
import type { ProgressReport } from "../work/types.ts";

export type LedgerOutcome = "followed" | "overridden" | "skipped" | "deferred" | "superseded" | "expired";
export const LEDGER_OUTCOMES: readonly LedgerOutcome[] = ["followed", "overridden", "skipped", "deferred", "superseded", "expired"];
/** explicit = the owner acted or said so; observed = DAVE inferred it from work events. */
export type LedgerBasis = "explicit" | "observed";
export type LedgerScope = "project" | "global";

/** An open row (outcome null) older than this closes as `expired`. */
export const LEDGER_EXPIRY_DAYS = 14;
export const REVIEW_MIN_DAYS = 7;
export const REVIEW_MAX_DAYS = 90;
export const REVIEW_DEFAULT_DAYS = 30;

export type LedgerRow = {
  id: string;
  scope: LedgerScope;
  /** The recommended project (for a global row, the project of DAVE's top pick). */
  projectId: string | null;
  objectiveId: string;
  /** Objective category or prepared action kind. */
  actionKind: string;
  title: string;
  targetItemIds: string[];
  score: number;
  reasons: { code: string; points: number; detail: string }[];
  recommendedAt: string;
  outcome: LedgerOutcome | null;
  outcomeBasis: LedgerBasis | null;
  outcomeAt: string | null;
  /** What the owner did instead, when known. */
  actualProjectId: string | null;
  actualTitle: string | null;
  actualRef: string | null;
  note: string | null;
};

export type ReviewSuggestion = { id: string; text: string; op: { op: "set_priority"; projectId: string; priority: number } };

export type ReviewReport = {
  days: number;
  totals: Record<LedgerOutcome | "open", number>;
  /** followed / (followed + overridden + skipped); null when that denominator is 0. */
  agreementRate: number | null;
  byKind: { kind: string; followed: number; total: number }[];
  byProject: { projectId: string; projectName: string; followed: number; overridden: number; total: number }[];
  /** ≤ 20, newest first. */
  overrides: { recommended: string; actual: string | null; reason: string | null; basis: LedgerBasis | null; at: string }[];
  /** Deterministic plain sentences, e.g. "You skipped 4 of 5 client follow-up recommendations". */
  patterns: string[];
  suggestions: ReviewSuggestion[];
};

/** What the onRecommendations hook hands the ledger after each reconcile (same transaction). */
export type RecommendationSnapshot = {
  byProject: ReadonlyMap<string, { objective: Objective | null }>;
  queue: readonly Objective[];
  trigger: string;
  at: string;
};

export type SkipInput = {
  actionId: string;
  projectId: string | null;
  objectiveId: string | null;
  kind: "skip" | "defer";
  reason: string | null;
  /** ISO; a defer lapses then. A skip without a date lapses only when the fingerprint changes. */
  until: string | null;
  fingerprint: string;
};
export type ActiveSkip = SkipInput & { createdAt: string };

export type ActedInput = {
  actionId: string;
  objectiveId: string | null;
  projectId: string | null;
  op: PreparedOpName;
  note: string | null;
};

/** What the next service needs from the ledger (W3 tests use a fake). */
export type LedgerApi = {
  skip(input: SkipInput): void;
  /** Skips still in force at `now` (defers past `until` are excluded; fingerprint checks are the caller's). */
  activeSkips(): ActiveSkip[];
  markActed(input: ActedInput): void;
  review(days: number): ReviewReport;
};

/** The extra hooks the server wires: reconcile → observe, work progress → onProgress. */
export type LedgerHooks = {
  observe(snapshot: RecommendationSnapshot): void;
  onProgress(report: ProgressReport): void;
};
