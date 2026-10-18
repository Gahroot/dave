import type {
  Blocker, DeliveryStage, EvidenceState, IntelItem, Objective, ObjectiveCategory, Provenance, ReadinessLevel,
} from "./types.ts";
import { hash } from "./store.ts";
import { blockerIndex, dayNumber, isOpen as open, laneOf } from "./scope.ts";

/**
 * Deterministic next-objective rules (no model). DAVE only decides WHAT should happen and WHY; the brief is
 * copyable text. This module must never import src/agents: nothing here launches anything.
 */
export type PrioritizeProject = {
  projectId: string;
  projectName: string;
  items: IntelItem[];
  stage: DeliveryStage;
  readiness: Record<ReadinessLevel, EvidenceState>;
  hasOutcome: boolean;
  outcomeDraftPending: boolean;
  /** Set when stored information is stale / sources are degraded. */
  uncertain: string | null;
  /** Your direction. Absent or empty = ranking exactly as without it. */
  direction?: { priority: number | null; focusItemIds: string[] };
};
export type ProjectObjectives = { objective: Objective | null; others: Objective[] };

const RESOURCE = /(credential|api[ -]?key|password|login|access|token|permission|sandbox|account|secret|certificate|dns|whitelist|invite)/i;

export function classify(text: string): ObjectiveCategory {
  if (/(sign.?off|accept|approval|approve)/i.test(text)) return "approval";
  if (/(\buat\b|\btest|\bqa\b|verif|validat)/i.test(text)) return "testing";
  if (/(deploy|release|go.?live|launch|production)/i.test(text)) return "deployment";
  if (/(train|onboard|walkthrough|hand.?over|\bdemo)/i.test(text)) return "training";
  if (RESOURCE.test(text)) return "access_configuration";
  if (/(investigat|research|look into|spike|scope out)/i.test(text)) return "investigation";
  if (/(build|implement|add|fix|integrat|develop|creat|write|ship|refactor|support|enable|connect|import|export|report)/i.test(text)) return "coding";
  return "client_action";
}
const HUMAN_ONLY = new Set<ObjectiveCategory>(["client_action", "access_configuration", "training", "approval"]);
export const isHumanOnly = (c: ObjectiveCategory): boolean => HUMAN_ONLY.has(c);

export const daysUntil = (due: string, now: Date): number => dayNumber(due) - dayNumber(now.toISOString());

type Reason = Objective["scoreReasons"][number];
function deadlineReason(due: string | null, now: Date, what: string): Reason | null {
  if (!due) return null;
  const d = daysUntil(due, now);
  if (d < 0) return { code: "deadline_overdue", points: 100, detail: `${what} was due ${due} (${-d} day(s) ago)` };
  if (d <= 3) return { code: "deadline_imminent", points: 80, detail: `${what} is due ${due} (${d} day(s))` };
  if (d <= 7) return { code: "deadline_soon", points: 60, detail: `${what} is due ${due}` };
  if (d <= 14) return { code: "deadline_upcoming", points: 40, detail: `${what} is due ${due}` };
  return { code: "deadline_later", points: 15, detail: `${what} is due ${due}` };
}
const earliest = (dates: (string | null)[]): string | null => dates.filter((d): d is string => !!d).sort()[0] ?? null;
const trim = (s: string, n = 140): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

type Candidate = Omit<Objective, "projectId" | "projectName" | "stage" | "score" | "scoreReasons" | "brief" | "humanOnly" | "id" | "uncertain" | "evidence"> & {
  key: string; reasons: Reason[]; targets: IntelItem[];
};

function candidates(p: PrioritizeProject, now: Date): Candidate[] {
  const out: Candidate[] = [];
  const byId = new Map(p.items.map((i) => [i.id, i]));
  // Only finish-line work is build work; bells and whistles (extra / phase 2) never become a build objective.
  const work = p.items.filter((i) => (i.kind === "requirement" || i.kind === "milestone") && open(i) && laneOf(i).lane === "finish_line");
  const { openBlockers, blockedBy: heldUp, blockerOf } = blockerIndex(p.items);
  const blockedBy = (b: IntelItem): IntelItem[] => heldUp.get(b.id) ?? [];

  // 1. Client / third-party blockers: get access instead of coding a blocked feature.
  for (const b of openBlockers) {
    const blocked = blockedBy(b);
    const reasons: Reason[] = [{ code: "external_blocker", points: 55, detail: `${b.owner === "client" ? "The client" : "A third party"} must provide this before work can finish` }];
    if (blocked.length) reasons.push({ code: "blocks_delivery", points: 25, detail: `Blocks ${blocked.length} open item(s): ${blocked.slice(0, 3).map((i) => i.title).join("; ")}` });
    const dl = deadlineReason(earliest([b.dueDate, ...blocked.map((i) => i.dueDate)]), now, "The earliest dependent date");
    if (dl) reasons.push(dl);
    const category: ObjectiveCategory = RESOURCE.test(b.title) ? "access_configuration" : "client_action";
    out.push({
      key: `blocker:${b.id}`, reasons, targets: [b, ...blocked], category,
      objective: `Get unblocked: ${trim(b.title)}`,
      whyNow: blocked.length ? `Work on ${blocked.slice(0, 2).map((i) => `"${trim(i.title, 60)}"`).join(", ")} cannot be finished until this arrives; more coding would not move delivery.` : "An external dependency is outstanding and nobody on our side can resolve it by coding.",
      definitionOfDone: ["The client or third party has supplied it", "It is confirmed working in the target environment", "The blocker is marked resolved in DAVE"],
      blockers: [{ itemId: b.id, text: b.title, owner: b.owner }], targetItemIds: [b.id, ...blocked.map((i) => i.id)], dueDate: earliest([b.dueDate, ...blocked.map((i) => i.dueDate)]),
    });
  }

  // 2. Commitments with dates (external promises outrank everything that has no date).
  for (const c of p.items.filter((i) => i.kind === "commitment" && open(i) && i.dueDate)) {
    const blockers = blockerOf.get(c.id) ?? [];
    if (blockers.length) continue; // covered by the unblock objective
    const category = classify(c.title);
    if (c.owner === "client") {
      const d = daysUntil(c.dueDate ?? "", now);
      if (d > 7) continue;
      out.push({
        key: `commitment:${c.id}`, targets: [c], category: "client_action", objective: `Follow up: ${trim(c.title)}`,
        whyNow: `The client promised this by ${c.dueDate}; follow up if it has not arrived.`, definitionOfDone: ["The client's deliverable has been received", "The commitment is marked done in DAVE"],
        blockers: [], targetItemIds: [c.id], dueDate: c.dueDate,
        reasons: [{ code: "client_dependency", points: 10, detail: "A client promise is pending" }, ...[deadlineReason(c.dueDate, now, "The client's date")].filter((x): x is Reason => !!x)],
      });
      continue;
    }
    if (c.evidenceState === "implementation_observed") continue; // validation objective covers it
    const reasons: Reason[] = [{ code: "external_commitment", points: 30, detail: "A commitment was made to the client" }];
    const dl = deadlineReason(c.dueDate, now, "The commitment");
    if (dl) reasons.push(dl);
    out.push({
      key: `commitment:${c.id}`, targets: [c], category, objective: `Meet commitment: ${trim(c.title)}`,
      whyNow: `${dl ? dl.detail : "A promise to the client is open"}; missing it damages trust.`,
      definitionOfDone: c.acceptance.length ? c.acceptance : [`"${trim(c.title, 80)}" is delivered to the client`, "The client has acknowledged it", "The commitment is marked done in DAVE"],
      blockers: [], targetItemIds: [c.id], dueDate: c.dueDate, reasons,
    });
  }

  // 3. Implemented but not verified: validate, do not call it done.
  const unverified = p.items.filter((i) => (i.kind === "requirement" || i.kind === "milestone") &&
    (i.evidenceState === "implementation_observed" || (i.status === "done" && i.evidenceState === "unverified")) && i.readinessReached === null);
  if (unverified.length) {
    const reasons: Reason[] = [{ code: "unverified_implementation", points: 45, detail: `${unverified.length} item(s) look implemented but nothing has verified them against acceptance` }];
    const dl = deadlineReason(earliest(unverified.map((i) => i.dueDate)), now, "The earliest related date");
    if (dl) reasons.push(dl);
    const criteria = unverified.flatMap((i) => i.acceptance).slice(0, 6);
    out.push({
      key: "validation", targets: unverified, category: "testing",
      objective: `Verify that ${unverified.slice(0, 3).map((i) => `"${trim(i.title, 60)}"`).join(", ")}${unverified.length > 3 ? " and more" : ""} actually meets the acceptance criteria`,
      whyNow: "Code evidence shows implementation, which is not proof the client's need is met. Validation is still outstanding.",
      definitionOfDone: [...(criteria.length ? criteria : ["The behaviour was exercised end to end against the agreed need"]), "The result is recorded in DAVE (marked verified or reopened)"],
      blockers: [], targetItemIds: unverified.map((i) => i.id), dueDate: earliest(unverified.map((i) => i.dueDate)), reasons,
    });
  }

  // 4. Remaining build work that is not blocked and whose dependencies are done.
  for (const w of work) {
    if (["implementation_observed", "verified", "blocked"].includes(w.evidenceState) || blockerOf.has(w.id)) continue;
    if (w.dependsOn.some((d) => { const dep = byId.get(d); return dep && dep.status !== "done" && dep.status !== "dropped" && dep.status !== "obsolete"; })) continue;
    const reasons: Reason[] = [{ code: "build_next", points: w.status === "in_progress" ? 35 : 30, detail: w.status === "in_progress" ? "Already in progress" : "Required scope that is not yet implemented" }];
    const dl = deadlineReason(w.dueDate, now, "It");
    if (dl) reasons.push(dl);
    out.push({
      key: `build:${w.id}`, targets: [w], category: "coding", objective: w.kind === "milestone" ? `Deliver milestone: ${trim(w.title)}` : `Deliver requirement: ${trim(w.title)}`,
      whyNow: dl ? `${dl.detail}.` : "It is the next unblocked piece of agreed scope.",
      definitionOfDone: w.acceptance.length ? w.acceptance : [`"${trim(w.title, 80)}" works as the client described`, "A check proves it and the result is recorded in DAVE"],
      blockers: [], targetItemIds: [w.id], dueDate: w.dueDate, reasons,
    });
  }

  // 5. Phase 4: everything verified but not yet in the client's hands.
  const tracked = p.items.filter((i) => (i.kind === "requirement" || i.kind === "milestone") && i.status !== "dropped" && i.status !== "obsolete");
  const allVerified = tracked.length > 0 && tracked.every((i) => i.evidenceState === "verified");
  const gapBase = (key: string, category: ObjectiveCategory, points: number, objective: string, why: string, dod: string[]): void => {
    out.push({ key, targets: tracked, category, objective, whyNow: why, definitionOfDone: dod, blockers: [], targetItemIds: tracked.map((i) => i.id),
      dueDate: earliest(tracked.map((i) => i.dueDate)), reasons: [{ code: "delivery_gap", points, detail: "Verified code is not yet usable by the client" }] });
  };
  if (allVerified && !openBlockers.length) {
    if (p.readiness.deployed !== "verified") {
      gapBase("gap:deployment", "deployment", 40, "Deploy to the client's environment with production configuration", "The work is verified but the client cannot use it until it is deployed and configured.",
        ["Deployed to the environment the client will use", "Production configuration and secrets are set", "A smoke test passes in production", "Deployment is recorded in DAVE"]);
    } else if (p.readiness.usable_by_client !== "verified") {
      gapBase("gap:training", "training", 35, "Onboard the client so they can actually use it", "It is deployed, but nothing shows the client can use it yet.",
        ["The client has working access", "A walkthrough or handover has happened", "The client completed a real task with it", "Onboarding is recorded in DAVE"]);
    } else if (p.readiness.client_accepted !== "verified") {
      gapBase("gap:approval", "approval", 40, "Get the client's acceptance", "The client can use it; acceptance has not been recorded.",
        ["The client has explicitly accepted (sign-off or written approval)", "Acceptance is recorded in DAVE with its source"]);
    }
  }

  // 6. No confirmed outcome yet.
  if (!p.hasOutcome && (p.outcomeDraftPending || p.items.length)) {
    out.push({
      key: "outcome", targets: [], category: "client_action", objective: "Confirm what successful delivery looks like for this client",
      whyNow: "Without an agreed outcome and acceptance criteria nothing can be called delivered.",
      definitionOfDone: ["The delivery outcome is written and confirmed", "Acceptance criteria are agreed with the client"],
      blockers: [], targetItemIds: [], dueDate: null, reasons: [{ code: "needs_outcome", points: 20, detail: "No confirmed delivery outcome" }],
    });
  }
  return out;
}

function evidenceOf(targets: IntelItem[]): Provenance[] {
  const seen = new Set<string>();
  const out: Provenance[] = [];
  for (const t of targets) for (const pv of t.provenance) {
    const k = `${pv.sourceKind}:${pv.sourceId ?? pv.label}`;
    if (!seen.has(k)) { seen.add(k); out.push(pv); }
  }
  return out.slice(0, 6);
}

export function briefFor(o: Pick<Objective, "objective" | "whyNow" | "definitionOfDone" | "blockers" | "evidence" | "projectName" | "dueDate">): string {
  const lines = [`Objective: ${o.objective}`, `Project: ${o.projectName}`, `Why now: ${o.whyNow}`];
  if (o.dueDate) lines.push(`Date: ${o.dueDate}`);
  lines.push("Definition of done:", ...o.definitionOfDone.map((d) => `- ${d}`));
  const ctx = o.evidence.filter((e) => e.quote).slice(0, 3).map((e) => `- ${e.label}: "${trim(e.quote ?? "", 160)}"`);
  if (ctx.length) lines.push("Context from the client:", ...ctx);
  lines.push("Constraints: stay within this objective; do not deploy, merge or contact the client; report what you changed and how you checked it so a person can verify it.");
  return lines.join("\n");
}

const order = (a: Objective, b: Objective): number =>
  b.score - a.score || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || a.projectName.localeCompare(b.projectName) || a.id.localeCompare(b.id);

/** Points for your project priority: #1 +45, #2 +30, #3 +18, #4 +8, #5 +0 (still listed). */
export const OWNER_PRIORITY_POINTS: Record<number, number> = { 1: 45, 2: 30, 3: 18, 4: 8, 5: 0 };
export const OWNER_FOCUS_POINTS = 60;

function directionReasons(c: Candidate, d: PrioritizeProject["direction"]): Reason[] {
  if (!d) return [];
  const out: Reason[] = [];
  if (d.focusItemIds.length && c.targetItemIds.some((id) => d.focusItemIds.includes(id))) {
    out.push({ code: "owner_focus", points: OWNER_FOCUS_POINTS, detail: "You told DAVE this matters most right now" });
  }
  const pts = d.priority === null ? undefined : OWNER_PRIORITY_POINTS[d.priority];
  if (d.priority !== null && pts !== undefined) {
    out.push({ code: "owner_priority", points: pts, detail: d.priority === 5 ? "You ranked this project #5" : `You ranked this project #${d.priority} of your priorities` });
  }
  return out;
}

export function prioritizeProject(p: PrioritizeProject, now: Date): ProjectObjectives {
  const built = candidates(p, now).map((c): Objective => {
    const scoreReasons = [...c.reasons, ...directionReasons(c, p.direction)].sort((a, b) => b.points - a.points || a.code.localeCompare(b.code));
    const humanOnly = isHumanOnly(c.category);
    const evidence = evidenceOf(c.targets);
    const inferredExternal = c.targets.some((t) => t.basis === "inferred" && (t.kind === "commitment" || t.kind === "blocker"));
    const base = {
      id: hash(p.projectId, "objective", c.category, c.key), projectId: p.projectId, projectName: p.projectName, stage: p.stage,
      objective: c.objective, whyNow: c.whyNow, definitionOfDone: c.definitionOfDone, category: c.category, blockers: c.blockers as Blocker[],
      evidence, targetItemIds: c.targetItemIds, humanOnly, score: scoreReasons.reduce((s, r) => s + r.points, 0), scoreReasons,
      dueDate: c.dueDate, uncertain: p.uncertain ?? (inferredExternal ? "Based on information DAVE inferred that nobody has confirmed yet." : null),
    };
    return { ...base, brief: humanOnly ? null : briefFor(base) };
  }).sort(order);
  return { objective: built[0] ?? null, others: built.slice(1, 9) };
}

export function prioritizeAll(projects: PrioritizeProject[], now: Date): { byProject: Map<string, ProjectObjectives>; queue: Objective[] } {
  const byProject = new Map<string, ProjectObjectives>();
  const queue: Objective[] = [];
  for (const p of projects) {
    const r = prioritizeProject(p, now);
    byProject.set(p.projectId, r);
    if (r.objective) queue.push(r.objective);
  }
  return { byProject, queue: queue.sort(order) };
}

/** R3 gaps: not implemented vs not verified vs unknown stay separate. */
export function computeGaps(p: PrioritizeProject): { itemId: string | null; text: string; state: EvidenceState; category: ObjectiveCategory }[] {
  const gaps: { itemId: string | null; text: string; state: EvidenceState; category: ObjectiveCategory }[] = [];
  const tracked = p.items.filter((i) => (i.kind === "requirement" || i.kind === "milestone") && i.status !== "dropped" && i.status !== "obsolete");
  for (const i of tracked) {
    if (i.evidenceState === "verified") continue;
    const text = i.evidenceState === "implementation_observed" ? `"${i.title}" looks implemented but is not verified`
      : i.evidenceState === "not_implemented" ? `"${i.title}" is not implemented` : i.evidenceState === "blocked" ? `"${i.title}" is blocked`
      : i.evidenceState === "unverified" ? `"${i.title}" is reported done but not verified` : `Status of "${i.title}" is unknown`;
    gaps.push({ itemId: i.id, text, state: i.evidenceState === "implementation_observed" ? "unverified" : i.evidenceState, category: i.evidenceState === "implementation_observed" || i.evidenceState === "unverified" ? "testing" : "coding" });
  }
  for (const b of p.items.filter((i) => i.kind === "blocker" && open(i))) {
    gaps.push({ itemId: b.id, text: `Waiting on ${b.owner === "me" ? "us" : b.owner}: ${b.title}`, state: "blocked", category: "access_configuration" });
  }
  if (tracked.length) {
    const r = p.readiness;
    if (r.deployed !== "verified") gaps.push({ itemId: null, text: "Deployment and production configuration are not recorded", state: "unknown", category: "deployment" });
    if (r.usable_by_client !== "verified") gaps.push({ itemId: null, text: "Client onboarding / ability to use it is not recorded", state: "unknown", category: "training" });
    if (r.client_accepted !== "verified") gaps.push({ itemId: null, text: "Client acceptance (UAT / sign-off) is not recorded", state: "unknown", category: "approval" });
  }
  return gaps;
}
