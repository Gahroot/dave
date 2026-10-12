/**
 * Delivery Intelligence contract (spec: C:\Users\Groot\Downloads\DAVE_Delivery_Intelligence_Spec.md).
 * Type-only: no Node imports, so the browser bundle can import it. Backend (src/intel/*) and UI
 * (src/ui/sections/focus/*) both build against this file. Do not change a field without telling the other side.
 *
 * DAVE decides WHAT should happen next and WHY. It never starts EZcoder: a brief is only copyable text.
 */

export type DeliveryStage = "discovery" | "building" | "integration" | "validation" | "deployment" | "onboarding" | "accepted";
export const DELIVERY_STAGES: readonly DeliveryStage[] = ["discovery", "building", "integration", "validation", "deployment", "onboarding", "accepted"];

/** R1: four different facts that must never be merged into "done". */
export type ReadinessLevel = "code_complete" | "deployed" | "usable_by_client" | "client_accepted";
export const READINESS_LEVELS: readonly ReadinessLevel[] = ["code_complete", "deployed", "usable_by_client", "client_accepted"];

export type Confidence = "high" | "medium" | "low";
/** confirmed = a human confirmed or wrote it; inferred = DAVE's reading of evidence. */
export type Basis = "confirmed" | "inferred";

export type SourceKind = "meeting" | "git" | "delivery-plan" | "project-summary" | "agent-task" | "human" | "derived";

/** Every inferred fact keeps where it came from, how fresh it is, and how sure we are. */
export type Provenance = {
  sourceKind: SourceKind;
  /** Stable id inside that source (meeting item id, commit subject hash, milestone id...). */
  sourceId: string | null;
  /** Short human label, e.g. "Call with Acme, 3 Oct". */
  label: string;
  /** Verbatim quote or detail that supports the fact, when one exists. */
  quote: string | null;
  /** When the source event happened / was observed (ISO). */
  observedAt: string;
  confidence: Confidence;
  /** Deep link inside DAVE, e.g. "#meetings?rec=123". Optional. */
  link: string | null;
};

export type ItemKind = "requirement" | "milestone" | "commitment" | "blocker" | "decision" | "exclusion";
export type ItemStatus = "open" | "in_progress" | "done" | "dropped" | "obsolete";
/**
 * R3: honest evidence state, kept apart.
 * not_implemented (no sign of it) | implementation_observed (code evidence, not proof) |
 * verified (acceptance check passed / human confirmed) | unverified (claimed, not checked) |
 * blocked | unknown (not enough information).
 */
export type EvidenceState = "not_implemented" | "implementation_observed" | "unverified" | "verified" | "blocked" | "unknown";
export type Owner = "me" | "client" | "third_party" | "unknown";

export type IntelItem = {
  /** Stable identity (hash of project + kind + normalised key); repeated meetings never create a second one. */
  id: string;
  projectId: string;
  kind: ItemKind;
  title: string;
  detail: string | null;
  basis: Basis;
  status: ItemStatus;
  evidenceState: EvidenceState;
  /** Which readiness level this item must reach before it counts as delivered (milestones/requirements). */
  readinessTarget: ReadinessLevel | null;
  /** Highest readiness level actually evidenced so far, null = none. */
  readinessReached: ReadinessLevel | null;
  owner: Owner;
  /** ISO date (YYYY-MM-DD) or null. */
  dueDate: string | null;
  /** Independently checkable criteria. */
  acceptance: string[];
  /** Other item ids that must complete first. */
  dependsOn: string[];
  /** Human locked this: reconciliation proposes changes but never applies them. */
  locked: boolean;
  provenance: Provenance[];
  /** Latest time any source still supported this item (freshness). */
  lastSupportedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectOutcome = {
  projectId: string;
  /** What successful use by the client looks like. */
  desiredOutcome: string;
  acceptanceCriteria: string[];
  stage: DeliveryStage;
  /** Which readiness level each statement is at, for the whole project. */
  readiness: Record<ReadinessLevel, EvidenceState>;
  basis: Basis;
  locked: boolean;
  provenance: Provenance[];
  /** ISO of the last reconcile pass for this project, null if never. */
  lastReconciledAt: string | null;
  updatedAt: string;
};

export type ObjectiveCategory = "coding" | "investigation" | "client_action" | "access_configuration" | "testing" | "deployment" | "training" | "approval";

export type Blocker = {
  itemId: string | null;
  text: string;
  owner: Owner;
};

/** R4. One per project plus a global ranking. */
export type Objective = {
  /** Stable per (project, target item/gap); an unchanged objective keeps its id between reconciles. */
  id: string;
  projectId: string;
  projectName: string;
  stage: DeliveryStage;
  /** Desired result, not an implementation command. */
  objective: string;
  whyNow: string;
  definitionOfDone: string[];
  category: ObjectiveCategory;
  /** Things that must happen first; if non-empty and owned by someone else, the objective is usually to unblock. */
  blockers: Blocker[];
  /** Links into the evidence behind the recommendation. */
  evidence: Provenance[];
  /** Item ids this objective advances. */
  targetItemIds: string[];
  /** Whether a developer can start this in EZcoder (coding/testing/deployment) vs a human-only step. */
  humanOnly: boolean;
  /** Copyable plain-text brief for EZcoder. Only text: DAVE never launches anything. null when humanOnly. */
  brief: string | null;
  /** Ranking transparency: total and the named contributions. */
  score: number;
  scoreReasons: { code: string; points: number; detail: string }[];
  dueDate: string | null;
  /** Information is stale or low-confidence: show it as uncertain. */
  uncertain: string | null;
};

export type ProposalKind = "outcome_draft" | "new_requirement" | "scope_change" | "deadline_change" | "new_commitment" | "mark_complete" | "mark_obsolete" | "conflict" | "clarification";
export type ProposalStatus = "pending" | "accepted" | "rejected" | "superseded";

/** R2: a proposed change to the living plan. Material changes wait for a human. */
export type Proposal = {
  id: string;
  projectId: string;
  projectName: string;
  kind: ProposalKind;
  /** True for scope, commitments, deadlines and anything touching a locked item: never auto-applied. */
  material: boolean;
  summary: string;
  detail: string | null;
  itemId: string | null;
  /** What accepting will do, as a structured patch applied server-side (shape owned by the backend). */
  patch: Record<string, unknown>;
  provenance: Provenance[];
  status: ProposalStatus;
  createdAt: string;
  resolvedAt: string | null;
};

export type ChangeEntry = {
  id: string;
  projectId: string | null;
  at: string;
  /** Why a recommendation / record changed, and from what event. */
  kind: "item_added" | "item_updated" | "item_completed" | "objective_changed" | "proposal_created" | "proposal_resolved" | "human_edit" | "reconcile_degraded";
  summary: string;
  itemId: string | null;
  sources: string[];
};

export type Freshness = "fresh" | "aging" | "stale" | "never";

export type SourceHealth = {
  source: "fathom" | "git" | "delivery-plan";
  state: "ok" | "degraded" | "unavailable" | "not_connected";
  lastSyncAt: string | null;
  detail: string | null;
};

export type ProjectFocusRow = {
  projectId: string;
  projectName: string;
  stage: DeliveryStage;
  outcome: string | null;
  outcomeBasis: Basis | null;
  objective: Objective | null;
  /** Highest readiness reached across the project. */
  readinessReached: ReadinessLevel | null;
  counts: { requirements: number; milestonesDone: number; milestonesTotal: number; openBlockers: number; pendingProposals: number };
  nextCommitment: { title: string; dueDate: string } | null;
  freshness: Freshness;
  lastReconciledAt: string | null;
};

/** GET /api/intel/focus: everything the home screen needs (R6). */
export type FocusState = {
  generatedAt: string;
  /** Top next action across all projects, null when nothing is known yet. */
  top: Objective | null;
  /** One objective per project, ranked. top === queue[0] when present. */
  queue: Objective[];
  projects: ProjectFocusRow[];
  /** Decisions waiting on the developer (pending proposals, ordered by urgency). */
  decisions: Proposal[];
  /** Client / external blockers and commitments due soon. */
  external: { blockers: (Blocker & { projectId: string; projectName: string })[]; commitments: { itemId: string; projectId: string; projectName: string; title: string; dueDate: string | null; owner: Owner }[] };
  recentChanges: ChangeEntry[];
  sources: SourceHealth[];
  lastReconciledAt: string | null;
};

/** GET /api/intel/projects/:id */
export type ProjectIntel = {
  projectId: string;
  projectName: string;
  outcome: ProjectOutcome | null;
  items: IntelItem[];
  objective: Objective | null;
  /** Ranked supporting work including human-only steps (excludes `objective`). */
  otherActions: Objective[];
  proposals: Proposal[];
  history: ChangeEntry[];
  /** Gaps against desired outcome, each labelled not_implemented / unverified / unknown. */
  gaps: { itemId: string | null; text: string; state: EvidenceState; category: ObjectiveCategory }[];
  freshness: Freshness;
  lastReconciledAt: string | null;
};

/** Routes (all under /api/intel, loopback + CSRF guard like the rest):
 *  GET  /focus                               -> FocusState
 *  GET  /projects/:id                        -> ProjectIntel
 *  POST /reconcile            {projectId?}   -> FocusState   (explicit refresh; also runs periodically)
 *  PUT  /projects/:id/outcome {desiredOutcome, acceptanceCriteria, stage?, lock?} -> ProjectIntel (human edit => basis confirmed)
 *  POST /projects/:id/items   {kind,title,detail?,dueDate?,owner?,acceptance?,dependsOn?} -> ProjectIntel (human-added, confirmed)
 *  PATCH /items/:itemId       {title?,detail?,status?,evidenceState?,owner?,dueDate?,acceptance?,locked?,readinessReached?,confirm?} -> ProjectIntel
 *  POST /proposals/:id/accept | /reject   {note?}  -> FocusState
 *  GET  /objectives/:id/brief                -> {brief:string}
 */
