import type {
  BehindScore, DeliveryPlan, DeliveryProgress, DeliveryStep, IntelItem, Lane, MarkableStep, Move, Proposal, ProposalKind, SuggestedTask,
} from "./types.ts";
import { DELIVERY_STEPS, LANES, MARKABLE_STEPS } from "./types.ts";
import type { StoredOutcome } from "./store.ts";
import { blockerIndex, dayNumber, isOpen, laneOf, POLISH, titleMatches } from "./scope.ts";

export { VISIBLE_MOVES } from "./types.ts";

/**
 * Delivery order and the copyable task list. Pure and deterministic: no I/O, `now` is passed in, inputs are sorted by
 * id first. DAVE only suggests and produces text; nothing here launches EZcoder or contacts anyone.
 */
export const BEHIND_WEIGHTS = Object.freeze({ schedule: 0.5, distance: 0.3, stalled: 0.2 }) satisfies BehindScore["weights"];
export const NO_DATE_WEIGHTS = Object.freeze({ schedule: 0, distance: 0.6, stalled: 0.4 }) satisfies BehindScore["weights"];
export const PRODUCTION_READY_SHARE = 70;
export const STEP_SHARE = 10;
export const STALLED_POINTS_PER_DAY = 7;
export const DEMO_UNSEEN_THRESHOLD = 3;
export const BAD_PATH_REOPENS = 2;
export const RISK = /(integrat|api\b|connect|sync|import|export|webhook|auth|login|oauth|payment|migrat|deploy)/i;

export type DeliveryInput = {
  projectId: string;
  projectName: string;
  now: Date;
  outcome: StoredOutcome | null;
  draftPending: boolean;
  items: IntelItem[];
  /** Pending proposals for this project. */
  pending: Proposal[];
  agentTasks: { title: string; status: string; summary: string | null }[];
  lastClientMeetingAt: string | null;
};
export type TaskContext = { projectName: string; desiredOutcome: string | null };

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const trim = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const clean = (s: string): string => s.trim().replace(/\s+/g, " ").replace(/[\s.;:,]+$/, "");
const upperFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
/** Lower-case a leading capital only when it starts an ordinary word ("Users" → "users"; "API", "I" stay). */
const lowerFirst = (s: string): string => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const sentence = (s: string): string => (s.endsWith("…") ? s : `${s}.`);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const time = (iso: string): number => Date.parse(iso);
const latest = (xs: (string | null | undefined)[]): string | null =>
  xs.filter((x): x is string => !!x && !Number.isNaN(time(x))).sort((a, b) => time(a) - time(b) || cmp(a, b)).at(-1) ?? null;

const isWork = (i: IntelItem): boolean => (i.kind === "requirement" || i.kind === "milestone") && i.status !== "dropped" && i.status !== "obsolete";
const isVerified = (i: IntelItem): boolean => i.evidenceState === "verified";
/** Built but unchecked: code evidence or a "done" report without your verification. Becomes a verify move, never a task. */
const looksBuilt = (i: IntelItem): boolean =>
  !isVerified(i) && (i.evidenceState === "implementation_observed" || i.evidenceState === "unverified" || i.status === "done");
const finishLine = (items: IntelItem[]): IntelItem[] => items.filter((i) => isWork(i) && laneOf(i).lane === "finish_line");

function normalise(input: DeliveryInput): DeliveryInput {
  return {
    ...input,
    items: [...input.items].sort((a, b) => cmp(a.id, b.id)),
    pending: [...input.pending].sort((a, b) => cmp(a.id, b.id)),
    agentTasks: [...input.agentTasks].sort((a, b) => cmp(a.title, b.title) || cmp(a.status, b.status) || cmp(a.summary ?? "", b.summary ?? "")),
  };
}

/** The service's existing decision urgency: conflicts and date changes first. Shared so both orders agree. */
export const PROPOSAL_RANK: Readonly<Record<ProposalKind, number>> = Object.freeze({
  conflict: 0, deadline_change: 1, new_commitment: 2, scope_change: 3, new_requirement: 4, mark_complete: 5, mark_obsolete: 6, outcome_draft: 7, clarification: 8,
});
export const proposalOrder = (a: Proposal, b: Proposal): number =>
  PROPOSAL_RANK[a.kind] - PROPOSAL_RANK[b.kind] || Number(b.material) - Number(a.material) || cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id);

// ---------------------------------------------------------------------------------------------------------------
// Score and progress

export function behindScore(a: { percentDone: number; startDate: string | null; targetDate: string | null; anchorAt: string | null; now: Date; delivered?: boolean }): BehindScore {
  const today = dayNumber(a.now.toISOString());
  const done = clamp(a.percentDone, 0, 100);
  const stalledDays = a.anchorAt ? Math.max(0, today - dayNumber(a.anchorAt)) : 0;
  const schedule = schedulePart(done, a.startDate, a.targetDate, today);
  const weights = schedule === null ? NO_DATE_WEIGHTS : BEHIND_WEIGHTS;
  const distance = 100 - done;
  const stalled = clamp(stalledDays * STALLED_POINTS_PER_DAY, 0, 100);
  const score = a.delivered ? 0 : Math.round(weights.schedule * (schedule ?? 0) + weights.distance * distance + weights.stalled * stalled);
  return { score, schedule, distance, stalled, stalledDays, weights: { ...weights } };
}

function schedulePart(done: number, startDate: string | null, targetDate: string | null, today: number): number | null {
  if (!targetDate) return null;
  const target = dayNumber(targetDate);
  const start = startDate ? dayNumber(startDate) : today;
  if (today > target || target <= start) return done >= 100 ? 0 : 100;
  const timeUsed = clamp((today - start) / (target - start), 0, 1);
  return clamp(Math.round((timeUsed - done / 100) * 200), 0, 100);
}

export function deliveryProgress(raw: DeliveryInput): DeliveryProgress {
  const input = normalise(raw);
  const o = input.outcome;
  const finish = finishLine(input.items);
  const verified = finish.filter(isVerified);
  const steps: Record<DeliveryStep, boolean> = {
    production_ready: finish.length > 0 && verified.length === finish.length,
    live: !!o?.liveAt, using: !!o?.usingAt, signed_off: !!o?.signedOffAt,
  };
  const marked = MARKABLE_STEPS.filter((s) => steps[s]).length;
  const percentDone = Math.round(PRODUCTION_READY_SHARE * (finish.length ? verified.length / finish.length : 0) + STEP_SHARE * marked);
  const currentStep = DELIVERY_STEPS.find((s) => !steps[s]) ?? null;
  const delivered = currentStep === null;
  const startDate = o ? (o.startDate ?? (o.confirmedAt ? o.confirmedAt.slice(0, 10) : null)) : null;
  const targetDate = o?.targetDate ?? null;
  const ownCommitments = input.items.filter((i) => i.kind === "commitment" && isOpen(i) && i.owner === "me");
  const suggestedTargetDate = [...finish, ...ownCommitments].map((i) => i.dueDate).filter((d): d is string => !!d).sort(cmp).at(-1) ?? null;
  const lastRealProgressAt = latest([...input.items.map((i) => i.verifiedAt), o?.liveAt, o?.usingAt, o?.signedOffAt]);
  const lastClientSeenAt = latest([input.lastClientMeetingAt, o?.lastDemoAt]);
  const unseenByClient = verified.filter((i) => i.verifiedAt && !Number.isNaN(time(i.verifiedAt)) && (!lastClientSeenAt || time(i.verifiedAt) > time(lastClientSeenAt))).length;
  const today = dayNumber(input.now.toISOString());
  return {
    confirmed: !!o, delivered, percentDone, finishLineItems: finish.length, verifiedItems: verified.length, steps, currentStep,
    stepNumber: currentStep ? DELIVERY_STEPS.indexOf(currentStep) + 1 : DELIVERY_STEPS.length + 1,
    startDate, targetDate, suggestedTargetDate, lastRealProgressAt, lastClientSeenAt, unseenByClient,
    waitingOnClient: blockerIndex(input.items).openBlockers.length > 0,
    overdue: !!targetDate && !delivered && today > dayNumber(targetDate),
    behind: o ? behindScore({ percentDone, startDate, targetDate, anchorAt: lastRealProgressAt ?? startDate, now: input.now, delivered }) : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Goal, done-when and why

/** A stored goal wins; a "so that" detail is used as is; otherwise DAVE drafts one and says so. */
export function draftGoal(item: IntelItem): { goal: string; drafted: boolean } {
  if (item.goal?.trim()) return { goal: item.goal.trim(), drafted: false };
  const detail = item.detail ? clean(item.detail) : "";
  if (/^so that\b/i.test(detail)) return { goal: sentence(trim(upperFirst(detail), 300)), drafted: false };
  if (detail && detail.toLowerCase() !== clean(item.title).toLowerCase()) return { goal: sentence(`So that ${trim(lowerFirst(detail), 290)}`), drafted: true };
  return { goal: sentence(`So that the client can ${trim(lowerFirst(clean(item.title)), 280)}`), drafted: true };
}

export function draftDoneWhen(item: IntelItem, goal: string): { doneWhen: string[]; drafted: boolean } {
  const acceptance = item.acceptance.map((a) => a.trim()).filter(Boolean);
  if (acceptance.length) return { doneWhen: acceptance, drafted: false };
  const body = clean(goal.replace(/^so that\s+/i, "").replace(/…$/, ""));
  return { doneWhen: [body ? `${upperFirst(body)}, checked end to end` : `"${clean(item.title)}" works as the client described, checked end to end`], drafted: true };
}

/** The client's own words when a meeting recorded them; otherwise the confirmed finish line. */
export function whyOf(item: IntelItem, outcome: Pick<StoredOutcome, "desiredOutcome"> | null): { why: string; source: string | null } {
  const quoted = item.provenance.find((p) => p.sourceKind === "meeting" && p.quote?.trim());
  if (quoted?.quote) return { why: `"${trim(quoted.quote.trim(), 200)}" (${quoted.label})`, source: quoted.label };
  const finish = outcome?.desiredOutcome ? clean(outcome.desiredOutcome) : "";
  if (finish) return { why: `Part of the agreed finish line: ${trim(finish, 160)}`, source: "Your confirmed finish line" };
  return { why: "Part of the agreed scope", source: null };
}

// ---------------------------------------------------------------------------------------------------------------
// Copyable text

export function taskText(t: Pick<SuggestedTask, "goal" | "why" | "build" | "doneWhen">, ctx: TaskContext): string {
  const finish = ctx.desiredOutcome ? clean(ctx.desiredOutcome) : "";
  return [
    t.goal, `Why: ${t.why}`, `Build: ${t.build}`, "Done when:", ...t.doneWhen.map((d) => `- ${d}`),
    `Context: ${ctx.projectName}.${finish ? ` Finish line: ${sentence(trim(finish, 160))}` : ""} Stay within this task; do not deploy, merge or contact the client. Report what you changed and how you checked it.`,
  ].join("\n");
}

/** Numbered, blank line between tasks, context repeated in each so every task stands alone. */
export function copyAllText(tasks: Pick<SuggestedTask, "goal" | "why" | "build" | "doneWhen">[], ctx: TaskContext): string {
  return tasks.map((t, n) => `${n + 1}. ${taskText(t, ctx)}`).join("\n\n");
}

/** Pitch-ready list of the bells and whistles, grouped by lane. */
export function extrasText(extras: Pick<SuggestedTask, "lane" | "build" | "goal">[]): string {
  const group = (lane: Lane, heading: string): string | null => {
    const xs = extras.filter((t) => t.lane === lane);
    return xs.length ? [heading, ...xs.map((t) => `- ${t.build}: ${t.goal}`)].join("\n") : null;
  };
  return [group("extra", "Extras"), group("phase2", "Phase 2")].filter((g): g is string => g !== null).join("\n\n");
}

// ---------------------------------------------------------------------------------------------------------------
// The plan

type Placement = Pick<SuggestedTask, "state" | "waitingOn" | "waitingMoveId" | "orderReason" | "inEzcoder">;
type Pause = { on: string; moveId: string | null };

function suggest(i: IntelItem, ctx: TaskContext, outcome: StoredOutcome | null, state: Placement): SuggestedTask {
  const { lane, guessed } = laneOf(i);
  const g = draftGoal(i);
  const d = draftDoneWhen(i, g.goal);
  const w = whyOf(i, outcome);
  const core = {
    itemId: i.id, lane, laneGuessed: guessed, build: i.title, goal: g.goal, goalDrafted: g.drafted, why: w.why, whySource: w.source,
    doneWhen: d.doneWhen, doneWhenDrafted: d.drafted, sentAt: i.sentAt, ...state,
  };
  return { ...core, text: taskText(core, ctx) };
}

const move = (m: Pick<Move, "id" | "kind" | "title" | "why" | "doneWhen"> & Partial<Move>): Move => ({
  itemId: null, proposalId: null, proposalKind: null, step: null, suggestedDate: null, ...m,
});

const risky = (i: IntelItem): boolean => RISK.test(`${i.title} ${i.detail ?? ""}`);
const WAIT_ON_DECISION = new Set<ProposalKind>(["conflict", "deadline_change", "scope_change"]);
const NOT_A_DECISION = new Set<ProposalKind>(["outcome_draft", "clarification"]);

/** Kahn's algorithm over the ready pool: a dependency is always emitted before the work that needs it. */
function orderReady(pool: IntelItem[]): { ordered: { item: IntelItem; reason: string }[]; cyclic: IntelItem[] } {
  const ids = new Set(pool.map((i) => i.id));
  const deps = new Map(pool.map((i) => [i.id, [...new Set(i.dependsOn)].filter((d) => d !== i.id && ids.has(d)).sort(cmp)]));
  const dependents = new Map<string, string[]>();
  for (const i of pool) for (const d of deps.get(i.id) ?? []) dependents.set(d, [...(dependents.get(d) ?? []), i.id]);
  const unblocks = (i: IntelItem): number => dependents.get(i.id)?.length ?? 0;
  const before = (a: IntelItem, b: IntelItem): number =>
    Number(b.status === "in_progress") - Number(a.status === "in_progress") || Number(risky(b)) - Number(risky(a)) ||
    cmp(a.dueDate ?? "9999-12-31", b.dueDate ?? "9999-12-31") || unblocks(b) - unblocks(a) || cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id);
  const reason = (i: IntelItem): string => {
    if (i.status === "in_progress") return "Already started";
    if (risky(i)) return "Riskiest part: prove it works first";
    if (i.dueDate) return `Due ${i.dueDate}`;
    const n = unblocks(i);
    return n ? `Unblocks ${plural(n, "task")}` : "Next in the agreed scope";
  };
  const indegree = new Map(pool.map((i) => [i.id, deps.get(i.id)?.length ?? 0]));
  const left = new Map(pool.map((i) => [i.id, i]));
  const ordered: { item: IntelItem; reason: string }[] = [];
  for (;;) {
    const next = [...left.values()].filter((i) => indegree.get(i.id) === 0).sort(before)[0];
    if (!next) break;
    left.delete(next.id);
    ordered.push({ item: next, reason: reason(next) });
    for (const d of dependents.get(next.id) ?? []) indegree.set(d, (indegree.get(d) ?? 1) - 1);
  }
  return { ordered, cyclic: [...left.values()] };
}

function confirmMove(draft: Proposal | null): Move {
  return move({
    id: "confirm_finish_line", kind: "confirm_finish_line", title: "Confirm the finish line",
    why: draft
      ? "DAVE drafted what \"works like the client imagined\" means for this project. Check it, edit it and confirm it. Until then no tasks are suggested."
      : "Write down what \"works like the client imagined\" means for this project. Until it is confirmed, no tasks are suggested.",
    proposalId: draft?.id ?? null, proposalKind: draft ? "outcome_draft" : null,
    doneWhen: ["The finish line is written and confirmed", "Its acceptance lines are what the client would check"],
  });
}

function decideWhy(p: Proposal, paused: number): string {
  const guess = p.kind === "new_requirement" && POLISH.test(`${p.summary} ${p.detail ?? ""}`) ? " DAVE's guess: an extra." : "";
  const base: Record<ProposalKind, string> = {
    conflict: "Two sources disagree. Nothing changes until you pick.",
    deadline_change: "A date moved. Accepting updates the plan.",
    new_commitment: "A promise was heard in a meeting. Confirm it or reject it.",
    scope_change: "The scope may have changed. Accepting updates the plan.",
    new_requirement: `The client asked for something new. File it on the finish line, as an extra or in Phase 2, or reject it.${guess}`,
    mark_complete: "A source says this is done. Done is not verified: you still check it.",
    mark_obsolete: "A source says this was dropped.",
    outcome_draft: "DAVE drafted the finish line.",
    clarification: "DAVE needs an answer.",
  };
  return paused ? `${base[p.kind]} ${plural(paused, "task")} ${paused === 1 ? "is" : "are"} paused on this.` : base[p.kind];
}

const STEP_MOVE: Record<MarkableStep, { title: string; why: string; doneWhen: string[] }> = {
  live: { title: "Go live where the client will use it", why: "Every finish-line item is verified, but the client cannot use it until it is live.", doneWhen: ["It is deployed where the client will use it", "Production settings are in place", "A quick check passes there"] },
  using: { title: "Get the client using it", why: "It is live, but nothing shows the client has used it yet.", doneWhen: ["The client has working access", "They completed a real task with it"] },
  signed_off: { title: "Get the client's sign-off", why: "The client is using it; their acceptance is not recorded.", doneWhen: ["The client accepted it in writing or on a call"] },
};

export function deliveryPlan(raw: DeliveryInput): DeliveryPlan {
  const input = normalise(raw);
  const progress = deliveryProgress(input);
  const outcome = input.outcome;
  const ctx: TaskContext = { projectName: input.projectName, desiredOutcome: outcome?.desiredOutcome ?? null };
  const laneRank = (i: IntelItem): number => LANES.indexOf(laneOf(i).lane);
  const extras = input.items.filter((i) => isWork(i) && isOpen(i) && !isVerified(i) && laneOf(i).lane !== "finish_line")
    .sort((a, b) => laneRank(a) - laneRank(b) || cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id))
    .map((i) => suggest(i, ctx, outcome, { state: i.sentAt ? "sent" : "ready", waitingOn: null, waitingMoveId: null, inEzcoder: false, orderReason: laneOf(i).lane === "phase2" ? "Phase 2" : "Extra" }));
  const extrasCopy = extrasText(extras);

  if (!progress.confirmed) {
    const draft = input.pending.filter((p) => p.kind === "outcome_draft").sort(proposalOrder)[0] ?? null;
    return { progress, moves: [confirmMove(draft)], ready: [], waiting: [], sent: [], extras, copyAll: "", extrasCopy };
  }

  const finish = finishLine(input.items);
  const index = blockerIndex(input.items);
  const activeTasks = input.agentTasks.filter((t) => t.status !== "done" && t.status !== "skipped");
  const decisions = input.pending.filter((p) => !NOT_A_DECISION.has(p.kind)).sort(proposalOrder);
  const candidates = finish.filter((i) => isOpen(i) && !isVerified(i) && !looksBuilt(i));
  const candidateIds = new Set(candidates.map((i) => i.id));
  const byId = new Map(input.items.map((i) => [i.id, i]));

  // Sent: copied (sentAt) or a matching EZcoder task that is still active.
  const inEzcoder = new Map(candidates.map((i) => [i.id, activeTasks.some((t) => titleMatches(i.title, t.title))]));
  const sentItems = candidates.filter((i) => i.sentAt || inEzcoder.get(i.id));
  const sentIds = new Set(sentItems.map((i) => i.id));
  const unsent = candidates.filter((i) => !sentIds.has(i.id));

  // Waiting: first matching reason wins.
  const paused = new Map<string, Pause>();
  for (const i of unsent) {
    const blocker = index.blockerOf.get(i.id)?.[0];
    const decision = decisions.find((p) => p.itemId === i.id && WAIT_ON_DECISION.has(p.kind));
    if (i.evidenceState === "blocked") paused.set(i.id, { on: "Marked blocked in the plan", moveId: null });
    else if (blocker) paused.set(i.id, { on: `Waiting on ${blocker.owner === "client" ? "the client" : "a third party"}: ${trim(blocker.title, 100)}`, moveId: `chase:${blocker.id}` });
    else if (decision) paused.set(i.id, { on: `Needs your decision: ${trim(decision.summary, 100)}`, moveId: `decide:${decision.id}` });
    else if (i.reopenCount >= BAD_PATH_REOPENS) paused.set(i.id, { on: `"Not right" ${plural(i.reopenCount, "time")}: rethink the goal`, moveId: `rethink:${i.id}` });
  }
  const depsOf = (i: IntelItem): string[] => [...new Set(i.dependsOn)].filter((d) => d !== i.id && candidateIds.has(d)).sort(cmp);
  for (let changed = true; changed;) {
    changed = false;
    for (const i of unsent) {
      if (paused.has(i.id)) continue;
      const dep = depsOf(i).find((d) => paused.has(d));
      const via = dep ? paused.get(dep) : undefined;
      if (dep && via) { paused.set(i.id, { on: `After: ${trim(byId.get(dep)?.title ?? dep, 100)}`, moveId: via.moveId }); changed = true; }
    }
  }
  const { ordered, cyclic } = orderReady(unsent.filter((i) => !paused.has(i.id)));
  const cyclicIds = new Set(cyclic.map((i) => i.id));
  for (const i of cyclic) {
    const dep = depsOf(i).find((d) => cyclicIds.has(d));
    paused.set(i.id, { on: `After: ${trim(byId.get(dep ?? "")?.title ?? "a task that also waits on this one", 100)}`, moveId: null });
  }

  const ready = ordered.map(({ item, reason }) => suggest(item, ctx, outcome, { state: "ready", waitingOn: null, waitingMoveId: null, inEzcoder: false, orderReason: reason }));
  const waiting = unsent.filter((i) => paused.has(i.id)).sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id)).map((i) => {
    const p = paused.get(i.id);
    return suggest(i, ctx, outcome, { state: "waiting", waitingOn: p?.on ?? null, waitingMoveId: p?.moveId ?? null, inEzcoder: false, orderReason: "Paused until you answer" });
  });
  const sent = sentItems.sort((a, b) => cmp(a.sentAt ?? "9999", b.sentAt ?? "9999") || cmp(a.id, b.id)).map((i) => {
    const matched = inEzcoder.get(i.id) ?? false;
    return suggest(i, ctx, outcome, { state: "sent", waitingOn: null, waitingMoveId: null, inEzcoder: matched, orderReason: i.sentAt ? `Sent ${i.sentAt.slice(0, 10)}` : "In EZcoder, matched by title" });
  });

  const pausedOn = (moveId: string): number => waiting.filter((t) => t.waitingMoveId === moveId).length;
  const moves: Move[] = [];
  for (const p of decisions) {
    moves.push(move({ id: `decide:${p.id}`, kind: "decide", title: p.summary, why: decideWhy(p, pausedOn(`decide:${p.id}`)), itemId: p.itemId, proposalId: p.id, proposalKind: p.kind, doneWhen: ["You accepted or rejected it in DAVE"] }));
  }
  const holds = (b: IntelItem): IntelItem[] => (index.blockedBy.get(b.id) ?? []).filter((i) => candidateIds.has(i.id));
  for (const b of [...index.openBlockers].sort((x, y) => holds(y).length - holds(x).length || cmp(x.dueDate ?? "9999", y.dueDate ?? "9999") || cmp(x.id, y.id))) {
    const held = holds(b);
    moves.push(move({
      id: `chase:${b.id}`, kind: "chase", itemId: b.id, title: `Chase ${b.owner === "client" ? "the client" : "the third party"}: ${trim(b.title, 120)}`,
      why: held.length ? `Holds up ${plural(held.length, "task")}: ${held.slice(0, 3).map((i) => trim(i.title, 60)).join("; ")}` : "Outstanding from them; nobody on your side can code around it.",
      doneWhen: ["They have supplied it", "It works where the client will use it", "The blocker is marked done in DAVE"],
    }));
  }
  for (const i of finish.filter(looksBuilt).sort((a, b) => cmp(a.updatedAt, b.updatedAt) || cmp(a.id, b.id))) {
    moves.push(move({
      id: `verify:${i.id}`, kind: "verify", itemId: i.id, title: `Check it works: ${trim(i.title, 120)}`,
      why: i.evidenceState === "implementation_observed"
        ? "Code or a finished EZcoder task suggests it is built. Only your check counts as progress."
        : "It is reported done, but nobody has checked it. Only your check counts as progress.",
      doneWhen: draftDoneWhen(i, draftGoal(i).goal).doneWhen,
    }));
  }
  for (const i of finish.filter((x) => isOpen(x) && !isVerified(x) && x.reopenCount >= BAD_PATH_REOPENS)) {
    moves.push(move({
      id: `rethink:${i.id}`, kind: "rethink", itemId: i.id, title: `Rethink: ${trim(i.title, 120)}`,
      why: `You said "Not right" ${plural(i.reopenCount, "time")}. Change the goal or move it to Phase 2 before sending it again.`,
      doneWhen: ["The goal is rewritten (this resets the count), or it is moved to Phase 2"],
    }));
  }
  const nextStep = progress.steps.production_ready ? MARKABLE_STEPS.find((s) => !progress.steps[s]) : undefined;
  if (nextStep) moves.push(move({ id: `step:${nextStep}`, kind: "step", step: nextStep, ...STEP_MOVE[nextStep] }));
  const unseen = progress.unseenByClient;
  if (unseen >= DEMO_UNSEEN_THRESHOLD || (progress.steps.production_ready && unseen >= 1)) {
    moves.push(move({
      id: "demo", kind: "demo", title: `Show the client ${plural(unseen, "verified item")}`,
      why: `${progress.lastClientSeenAt ? `They have not seen these since ${progress.lastClientSeenAt.slice(0, 10)}.` : "They have not seen any verified work yet."} Showing it early catches "not what I meant" while it is cheap to fix.`,
      doneWhen: ["You showed it on a call or demo (the next linked meeting also clears this)"],
    }));
  }
  if (!progress.targetDate && !progress.delivered) {
    const d = progress.suggestedTargetDate;
    moves.push(move({
      id: "target_date", kind: "target_date", title: "Set a target date", suggestedDate: d,
      why: `${d ? `The latest agreed date is ${d}. ` : ""}With a target, DAVE can tell whether you are behind schedule, not just how far there is to go.`,
      doneWhen: ["A target date is set"],
    }));
  }

  return { progress, moves, ready, waiting, sent, extras, copyAll: copyAllText(ready, ctx), extrasCopy };
}

/** The home row's one-line next move: your first move, else the send prompt, else why everything is paused. */
export function nextMoveText(plan: Pick<DeliveryPlan, "moves" | "ready" | "waiting">): string | null {
  const first = plan.moves[0];
  if (first) return first.title;
  if (plan.ready.length) return `Send ${plural(plan.ready.length, "task")} to EZcoder`;
  return plan.waiting[0]?.waitingOn ?? null;
}
