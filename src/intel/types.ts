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

/** Where a piece of work sits relative to the agreed finish line. null on an item = DAVE decides at read time. */
export type Lane = "finish_line" | "extra" | "phase2";
export const LANES: readonly Lane[] = ["finish_line", "extra", "phase2"];

/** The four delivery steps, in order. Production-ready comes from verified items; the rest are marked by you. */
export type DeliveryStep = "production_ready" | "live" | "using" | "signed_off";
export const DELIVERY_STEPS: readonly DeliveryStep[] = ["production_ready", "live", "using", "signed_off"];
export type MarkableStep = "live" | "using" | "signed_off";
export const MARKABLE_STEPS: readonly MarkableStep[] = ["live", "using", "signed_off"];

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
  /** Your filing of this work. null = DAVE guesses at read time (labelled as a guess). */
  lane: Lane | null;
  /** Your "So that …" goal for the task. null = DAVE drafts one. */
  goal: string | null;
  /** When you last verified it. Only this counts as real progress. */
  verifiedAt: string | null;
  /** When its task text was copied to EZcoder (copying is sending). */
  sentAt: string | null;
  /** How many times you said "Not right" since the goal last changed. */
  reopenCount: number;
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

/** "How far behind" with its named parts, each 0–100. Weights change when there is no target date. */
export type BehindScore = {
  score: number;
  /** null when there is no target date. */
  schedule: number | null;
  distance: number;
  stalled: number;
  stalledDays: number;
  weights: { schedule: number; distance: number; stalled: number };
};

/** Delivery progress derived only from verified items and steps you marked. Shown with its parts, never alone. */
export type DeliveryProgress = {
  /** A person confirmed the finish line (an outcome row exists). */
  confirmed: boolean;
  delivered: boolean;
  percentDone: number;
  finishLineItems: number;
  verifiedItems: number;
  steps: Record<DeliveryStep, boolean>;
  /** First step not yet reached; null when delivered. */
  currentStep: DeliveryStep | null;
  /** 1–4, or 5 when delivered. */
  stepNumber: number;
  startDate: string | null;
  targetDate: string | null;
  /** One-click suggestion: the latest finish-line or own-commitment due date. */
  suggestedTargetDate: string | null;
  lastRealProgressAt: string | null;
  lastClientSeenAt: string | null;
  /** Verified finish-line items the client has not seen in a meeting or demo since. */
  unseenByClient: number;
  waitingOnClient: boolean;
  overdue: boolean;
  /** null when the finish line is not confirmed. */
  behind: BehindScore | null;
};

export type MoveKind = "confirm_finish_line" | "decide" | "chase" | "verify" | "rethink" | "step" | "demo" | "target_date";
/** At most this many moves are shown at once; the rest sit behind a disclosure. */
export const VISIBLE_MOVES = 3;

/** Something only you can do. DAVE never does it for you. */
export type Move = {
  /** Readable composite, e.g. "verify:<itemId>". */
  id: string;
  kind: MoveKind;
  title: string;
  why: string;
  itemId: string | null;
  proposalId: string | null;
  proposalKind: ProposalKind | null;
  step: MarkableStep | null;
  suggestedDate: string | null;
  doneWhen: string[];
};

export type TaskState = "ready" | "waiting" | "sent";

/** One standalone EZcoder task, as copyable text. DAVE never launches it. */
export type SuggestedTask = {
  itemId: string;
  lane: Lane;
  /** The lane is DAVE's guess (no stored choice). */
  laneGuessed: boolean;
  /** What to build (the item title). */
  build: string;
  /** "So that …" */
  goal: string;
  goalDrafted: boolean;
  why: string;
  whySource: string | null;
  doneWhen: string[];
  doneWhenDrafted: boolean;
  state: TaskState;
  /** Why it is paused, when state is waiting. */
  waitingOn: string | null;
  /** The move that unpauses it, when one exists. */
  waitingMoveId: string | null;
  orderReason: string;
  sentAt: string | null;
  /** Sent because a matching EZcoder task already exists (matched by title). */
  inEzcoder: boolean;
  text: string;
};

export type DeliveryPlan = {
  progress: DeliveryProgress;
  moves: Move[];
  ready: SuggestedTask[];
  waiting: SuggestedTask[];
  sent: SuggestedTask[];
  /** Bells & whistles: open work in the extra and phase2 lanes. */
  extras: SuggestedTask[];
  copyAll: string;
  extrasCopy: string;
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
  delivery: DeliveryProgress;
  /** First move's title, else "Send N tasks to EZcoder", else the first pause reason. */
  nextMove: string | null;
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
  /** Finish line, your moves and the copyable task list. */
  plan: DeliveryPlan;
};

/** Routes (all under /api/intel, loopback + CSRF guard like the rest):
 *  GET  /focus                               -> FocusState
 *  GET  /projects/:id                        -> ProjectIntel
 *  POST /reconcile            {projectId?}   -> FocusState   (explicit refresh; also runs periodically)
 *  PUT  /projects/:id/outcome {desiredOutcome, acceptanceCriteria, stage?, lock?, targetDate?, startDate?} -> ProjectIntel (human edit => basis confirmed)
 *  PUT  /projects/:id/schedule {targetDate, startDate?}   -> ProjectIntel (409 until the finish line is confirmed)
 *  POST /projects/:id/steps   {step: live|using|signed_off, reached} -> ProjectIntel
 *  POST /projects/:id/demo    {}             -> ProjectIntel  ("Shown to the client")
 *  POST /projects/:id/tasks/sent {itemIds, sent} -> ProjectIntel (copying is sending; every id must belong to the project)
 *  POST /projects/:id/finish-line {items[], acceptance?} -> {added, skipped, intel}
 *  POST /projects/:id/items   {kind,title,detail?,dueDate?,owner?,acceptance?,dependsOn?} -> ProjectIntel (human-added, confirmed)
 *  PATCH /items/:itemId       {title?,detail?,status?,evidenceState?,owner?,dueDate?,acceptance?,locked?,readinessReached?,confirm?,lane?,goal?} -> ProjectIntel
 *  POST /items/:itemId/verify {}             -> ProjectIntel
 *  POST /items/:itemId/reopen {note?}        -> ProjectIntel
 *  POST /proposals/:id/accept | /reject   {note?, lane? (accept, new_requirement only)}  -> FocusState
 *  GET  /objectives/:id/brief                -> {brief:string}
 */
