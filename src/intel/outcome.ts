import type { DeliveryStage, EvidenceState, IntelItem, ProjectOutcome, Provenance, ReadinessLevel } from "./types.ts";
import { READINESS_LEVELS } from "./types.ts";
import type { NewProposal, StoredOutcome } from "./store.ts";
import type { IntelStore } from "./store.ts";
import type { ReconcileInput } from "./reconcile.ts";

const RANK: Record<ReadinessLevel, number> = { code_complete: 0, deployed: 1, usable_by_client: 2, client_accepted: 3 };
const trackable = (i: IntelItem): boolean => (i.kind === "requirement" || i.kind === "milestone") && i.status !== "dropped" && i.status !== "obsolete";

/**
 * R1: four separate facts. Code evidence alone can only reach implementation_observed for code_complete;
 * deployed / usable / accepted stay unknown until a person records them on the items.
 */
export function deriveReadiness(items: IntelItem[]): Record<ReadinessLevel, EvidenceState> {
  const tracked = items.filter(trackable);
  const out = {} as Record<ReadinessLevel, EvidenceState>;
  for (const level of READINESS_LEVELS) {
    if (!tracked.length) { out[level] = "unknown"; continue; }
    const reached = tracked.filter((i) => i.readinessReached !== null && RANK[i.readinessReached] >= RANK[level]);
    if (reached.length === tracked.length) { out[level] = "verified"; continue; }
    if (level === "code_complete" && tracked.every((i) => i.evidenceState === "implementation_observed" || i.evidenceState === "verified" || reached.includes(i))) { out[level] = "implementation_observed"; continue; }
    out[level] = level === "code_complete" ? (tracked.some((i) => i.evidenceState !== "not_implemented") ? "unverified" : "not_implemented") : "unknown";
  }
  return out;
}

/**
 * Readiness from the items, upgraded by the project-level step marks a person recorded (live, client using it,
 * signed off). A mark is a person's statement, so that level counts as verified; nothing is ever downgraded.
 */
export function readinessWithSteps(items: IntelItem[], outcome: Pick<StoredOutcome, "liveAt" | "usingAt" | "signedOffAt"> | null): Record<ReadinessLevel, EvidenceState> {
  const out = deriveReadiness(items);
  if (!outcome) return out;
  if (outcome.liveAt) out.deployed = "verified";
  if (outcome.usingAt) out.usable_by_client = "verified";
  if (outcome.signedOffAt) out.client_accepted = "verified";
  return out;
}

export function deriveStage(items: IntelItem[], readiness: Record<ReadinessLevel, EvidenceState>, hasActivity: boolean): DeliveryStage {
  const tracked = items.filter(trackable);
  if (readiness.client_accepted === "verified") return "accepted";
  if (readiness.deployed === "verified") return "onboarding";
  const codeDone = tracked.length > 0 && tracked.every((i) => i.evidenceState === "implementation_observed" || i.evidenceState === "verified");
  const codeVerified = tracked.length > 0 && tracked.every((i) => i.evidenceState === "verified");
  if (codeVerified) return "deployment";
  if (codeDone) return "validation";
  const external = items.some((i) => i.kind === "blocker" && i.status === "open" && i.owner !== "me");
  if (external && tracked.some((i) => i.evidenceState === "implementation_observed")) return "integration";
  if (tracked.length > 0 || hasActivity) return "building";
  return "discovery";
}

export function projectOutcome(store: IntelStore, projectId: string, items: IntelItem[], hasActivity: boolean): ProjectOutcome | null {
  const o = store.outcome(projectId);
  if (!o) return null;
  const readiness = readinessWithSteps(items, o);
  const rec = store.reconciled(projectId);
  return {
    projectId, desiredOutcome: o.desiredOutcome, acceptanceCriteria: o.acceptanceCriteria,
    stage: o.stageOverride ?? deriveStage(items, readiness, hasActivity), readiness, basis: o.basis, locked: o.locked,
    provenance: o.provenance, lastReconciledAt: rec?.at ?? null, updatedAt: o.updatedAt,
  };
}

const short = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * R1 drafting: with no outcome yet, propose one from evidence and raise the open uncertainties as clarifications.
 * Never writes the outcome itself; a person accepts. Silent for projects with no evidence at all.
 */
export function draftOutcome(store: IntelStore, input: ReconcileInput, at: string, propose: (p: NewProposal) => void): void {
  if (store.outcome(input.projectId)) return;
  const items = store.items(input.projectId);
  const hasEvidence = !!(input.goal || input.summary?.recentFocus || input.summary?.unfinished || input.meetings.length || items.length || input.commits.length);
  if (!hasEvidence) return;
  const provenance: Provenance[] = [];
  let text: string | null = null;
  let confidence: Provenance["confidence"] = "low";
  if (input.goal) {
    text = input.goal; confidence = "high";
    provenance.push({ sourceKind: "delivery-plan", sourceId: "goal", label: "Delivery goal", quote: short(input.goal, 200), observedAt: at, confidence: "high", link: null });
  }
  const headline = input.meetings.find((m) => m.headline);
  if (headline?.headline) {
    if (!text) { text = headline.headline; confidence = "medium"; }
    provenance.push({ sourceKind: "meeting", sourceId: headline.recordingId, label: `${headline.title}, ${headline.at.slice(0, 10)}`, quote: short(headline.headline, 200), observedAt: headline.at, confidence: "medium", link: `#meetings?rec=${headline.recordingId}` });
  }
  const focus = input.summary?.unfinished ?? input.summary?.recentFocus ?? null;
  if (focus) {
    if (!text) text = `Deliver: ${focus}`;
    provenance.push({ sourceKind: "project-summary", sourceId: "summary", label: "Project summary", quote: short(focus, 200), observedAt: at, confidence: "low", link: null });
  }
  if (!text && items.length) text = `Deliver ${items.filter(trackable).slice(0, 3).map((i) => i.title).join("; ") || input.projectName} for ${input.projectName}`;
  const criteria = [...new Set(items.filter(trackable).flatMap((i) => i.acceptance))].slice(0, 6);
  const drafted = store.proposals(input.projectId).some((p) => p.kind === "outcome_draft");
  if (text && !drafted) {
    const acceptanceCriteria = [...criteria, "The work is deployed where the client will use it", "The client has used it and confirmed it meets the need"];
    propose({
      projectId: input.projectId, kind: "outcome_draft", material: true,
      summary: `Confirm the delivery outcome for ${input.projectName} (confidence: ${confidence})`,
      detail: "Drafted from the available evidence. Edit it before accepting.",
      patch: { op: "set_outcome", desiredOutcome: short(text, 500), acceptanceCriteria, confidence },
      provenance,
    });
  }
  const clar: [string, string][] = [];
  if (!text) clar.push(["outcome", `What does successful use by the client look like for ${input.projectName}?`]);
  if (!criteria.length) clar.push(["acceptance", `No acceptance criteria are recorded for ${input.projectName}. How will the client decide it is acceptable?`]);
  if (!items.some((i) => i.dueDate) && !input.meetingItems.some((m) => m.dueDate)) clar.push(["deadline", `Is there a date the client expects ${input.projectName} by? None is recorded.`]);
  if (!input.meetings.length) clar.push(["client", `No client meetings are linked to ${input.projectName}. Who signs off acceptance?`]);
  for (const [code, summary] of clar.slice(0, 4)) {
    propose({ projectId: input.projectId, kind: "clarification", material: false, summary, patch: { op: "ack", code }, provenance: [] });
  }
}

export type { StoredOutcome };
