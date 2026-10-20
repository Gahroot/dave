/**
 * Prepared next actions (pure, deterministic). Turns what DAVE already knows (focus, per-project intel, firm meeting
 * promises and recent work progress) into ready-to-take actions: one primary op, a draft where words are needed,
 * done-when checks, evidence labels and what DAVE could not confirm. Nothing here writes or starts anything.
 */
import { hash } from "./store.ts";
import type { FocusState, IntelItem, Move, Objective, ProjectIntel, Proposal, ProposalKind, Provenance, SourceKind } from "./types.ts";
import type { PreparedAction, PreparedDraft, PreparedOp } from "./next-types.ts";
import type { ActiveSkip } from "./ledger-types.ts";
import type { ProgressReport } from "../work/types.ts";

/** A firm, open meeting promise (the caller keeps only firm ones). */
export type PromiseInput = {
  id: string;
  projectId: string;
  projectName: string | null;
  text: string;
  dueDate: string | null;
  meetingTitle: string;
  meetingAt: string;
  /** Evidence suggests it is done ("Looks done?"). */
  looksDone: boolean;
};

export type PrepareInput = {
  now: Date;
  focus: FocusState;
  /** Intel for the projects worth preparing (top N), any order. */
  projects: ProjectIntel[];
  promises: PromiseInput[];
  /** Recent progress reports, any order. */
  progress: ProgressReport[];
};

export const BOOST_OVERDUE = 30;
export const BOOST_JUST_MOVED = 20;
export const BOOST_BATCH = 10;
/** Promises due within this many days (or overdue) get a follow-up. */
export const FOLLOW_UP_DAYS = 14;
/** A verify counts as "just moved" when its report is this recent. */
const JUST_MOVED_MS = 48 * 3_600_000;
const DAY_MS = 86_400_000;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const trim = (s: string, n = 120): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const isOpen = (i: IntelItem): boolean => i.status === "open" || i.status === "in_progress";
const day = (d: Date): string => d.toISOString().slice(0, 10);
const daysBetween = (fromIso: string, now: Date): number => Math.max(0, Math.floor((now.getTime() - Date.parse(fromIso)) / DAY_MS));

const SKIP_DEFER = (now: Date): { label: string; op: PreparedOp }[] => [
  { label: "Skip", op: { op: "skip" } },
  { label: "Later", op: { op: "defer", until: new Date(now.getTime() + DAY_MS).toISOString() } },
];

type Draft = Omit<PreparedAction, "id" | "secondary" | "fingerprint" | "score"> & {
  secondary?: PreparedAction["secondary"];
  base: number;
  boost: number;
  /** What the id is stable over (besides kind and project). */
  target: string;
  /** The evidence the action rests on; its hash is the fingerprint. */
  basis: unknown;
};

function finish(d: Draft, now: Date): PreparedAction {
  const { base, boost, target, basis, secondary, ...rest } = d;
  return {
    ...rest,
    id: hash("prepared", d.kind, d.projectId, target),
    secondary: [...(secondary ?? []), ...SKIP_DEFER(now)],
    score: base + boost,
    fingerprint: hash("fingerprint", JSON.stringify(basis)),
  };
}

const chip = (p: Provenance): PreparedAction["evidence"][number] => ({ label: p.label, at: p.observedAt, sourceKind: p.sourceKind });
const chipOf = (label: string, at: string | null, sourceKind: SourceKind): PreparedAction["evidence"][number] => ({ label, at, sourceKind });

function base(pi: ProjectIntel, focus: FocusState): number {
  return pi.objective?.score ?? focus.queue.find((o) => o.projectId === pi.projectId)?.score ?? 0;
}

// ---- build -------------------------------------------------------------------------------------------------

function build(pi: ProjectIntel, o: Objective, now: Date): Draft | null {
  if (o.category !== "coding" || o.humanOnly || !o.brief) return null;
  return {
    projectId: pi.projectId, projectName: pi.projectName, kind: "build", title: `Build: ${trim(o.objective)}`, whyNow: o.whyNow,
    effort: "hand_off", primary: { label: "Hand to EZ Coder", op: { op: "hand_to_ezcoder", objectiveId: o.id } },
    draft: { kind: "brief", to: null, subject: null, text: o.brief }, doneWhen: o.definitionOfDone,
    evidence: o.evidence.slice(0, 5).map(chip), missing: o.uncertain ? [o.uncertain] : [],
    objectiveId: o.id, targetItemIds: o.targetItemIds, uncertain: o.uncertain,
    base: o.score, boost: o.dueDate && o.dueDate < day(now) ? BOOST_OVERDUE : 0,
    target: o.id, basis: { o: o.id, t: o.targetItemIds, b: o.brief },
  };
}

// ---- verify and retry (from work progress) ------------------------------------------------------------------

function verify(pi: ProjectIntel, reports: ProgressReport[], now: Date, b: number): Draft | null {
  const byId = new Map(pi.items.map((i) => [i.id, i]));
  const moved = reports.filter((r) => r.verdict === "moved" || r.verdict === "partial");
  const seen = new Set<string>();
  const items: { item: IntelItem; report: ProgressReport }[] = [];
  for (const r of moved) {
    for (const d of r.advanced) {
      const item = byId.get(d.itemId);
      if (!item || seen.has(item.id) || item.evidenceState === "verified" || !isOpen(item)) continue;
      seen.add(item.id);
      items.push({ item, report: r });
    }
  }
  if (!items.length) return null;
  items.sort((a, b2) => cmp(a.item.id, b2.item.id));
  const newest = moved.map((r) => r.at).sort().pop() ?? null;
  const just = newest !== null && now.getTime() - Date.parse(newest) <= JUST_MOVED_MS;
  const lines: string[] = [`Check these in ${pi.projectName}:`];
  for (const { item, report } of items) {
    lines.push("", `- ${item.title}`);
    for (const a of item.acceptance) lines.push(`  [ ] ${a}`);
    if (!item.acceptance.length) lines.push("  [ ] It works the way the client expects");
    lines.push(`  Evidence: ${report.headline}`);
  }
  const first = items[0];
  const title = items.length === 1 && first ? `Check it works: ${trim(first.item.title)}` : `Check ${plural(items.length, "item")} that just moved`;
  return {
    projectId: pi.projectId, projectName: pi.projectName, kind: "verify", title,
    whyNow: "New work looks implemented. Only your check counts as progress.",
    effort: "review_then_tap", primary: { label: "Copy checklist", op: { op: "copy" } },
    secondary: items.slice(0, 3).map(({ item }) => ({ label: `Mark verified: ${trim(item.title, 60)}`, op: { op: "mark_verified", itemId: item.id } satisfies PreparedOp })),
    draft: { kind: "checklist", to: null, subject: null, text: lines.join("\n") },
    doneWhen: ["You checked each item and marked it verified, or said it is not right"],
    evidence: items.map(({ report }) => chipOf(report.headline, report.at, report.source === "ezcoder" ? "agent-task" : "git")).slice(0, 5),
    missing: items.map(({ item }) => `Nobody has checked "${trim(item.title, 80)}" yet`),
    objectiveId: pi.objective?.id ?? null, targetItemIds: items.map(({ item }) => item.id), uncertain: null,
    base: b, boost: just ? BOOST_JUST_MOVED : 0,
    target: items.map(({ item }) => item.id).join(","), basis: items.map(({ item, report }) => [item.id, item.evidenceState, item.status, report.eventId]),
  };
}

function retry(pi: ProjectIntel, reports: ProgressReport[], b: number): Draft | null {
  const sorted = [...reports].sort((x, y) => cmp(y.at, x.at) || cmp(x.eventId, y.eventId));
  const latest = sorted[0];
  if (!latest || latest.verdict !== "failed") return null;
  const o = pi.objective;
  const missing = latest.stillMissing.slice(0, 5).map((m) => `- ${m.title}: ${m.why}`);
  const text = [
    `Try again in ${pi.projectName}.`, "", `Last run: ${latest.headline}`,
    ...(missing.length ? ["", "Still missing:", ...missing] : []),
    ...(o?.brief ? ["", o.brief] : []),
  ].join("\n");
  return {
    projectId: pi.projectId, projectName: pi.projectName, kind: "retry", title: `Retry: ${trim(latest.headline)}`,
    whyNow: "The last run did not finish, so nothing moved.",
    effort: o ? "hand_off" : "do_yourself",
    primary: o ? { label: "Hand to EZ Coder", op: { op: "hand_to_ezcoder", objectiveId: o.id } } : { label: "Copy brief", op: { op: "copy" } },
    draft: { kind: "brief", to: null, subject: null, text },
    doneWhen: ["A new run finishes and the work moves"],
    evidence: [chipOf(latest.headline, latest.at, latest.source === "ezcoder" ? "agent-task" : "git")],
    missing: ["DAVE does not know why the run failed beyond its last message"],
    objectiveId: o?.id ?? null, targetItemIds: o?.targetItemIds ?? [], uncertain: null,
    base: b, boost: 0, target: latest.eventId, basis: [latest.eventId, latest.verdict],
  };
}

// ---- decide ------------------------------------------------------------------------------------------------

type Recommendation = { answer: "accept" | "review"; reason: string };
const CODE_KINDS: ReadonlySet<SourceKind> = new Set(["git", "agent-task"]);

export function recommend(p: Proposal): Recommendation {
  if (p.kind === "conflict") return { answer: "review", reason: "Two sources disagree; only you know which is right." };
  if (p.kind === "mark_complete") {
    return p.provenance.some((x) => CODE_KINDS.has(x.sourceKind))
      ? { answer: "accept", reason: "Code evidence backs it. Accepting does not mark it verified." }
      : { answer: "review", reason: "No code evidence backs it yet." };
  }
  if (p.kind === "deadline_change") {
    return p.provenance.some((x) => x.sourceKind === "meeting")
      ? { answer: "accept", reason: "A newer meeting set this date." }
      : { answer: "review", reason: "DAVE could not tie the new date to a meeting." };
  }
  if (p.kind === "new_commitment") return { answer: "accept", reason: "It was said as a promise in a meeting." };
  if (p.kind === "new_requirement") return { answer: "accept", reason: "The client asked for it; you can still file it as an extra." };
  if (p.kind === "mark_obsolete") return { answer: "accept", reason: "A source says it was dropped." };
  return { answer: "review", reason: "DAVE needs your answer." };
}

const KIND_WORD: Record<ProposalKind, string> = {
  outcome_draft: "finish line drafts", new_requirement: "new requests", scope_change: "scope changes", deadline_change: "date changes",
  new_commitment: "new promises", mark_complete: "items reported done", mark_obsolete: "items reported dropped", conflict: "conflicts", clarification: "questions",
};

function decide(pi: ProjectIntel, b: number): Draft[] {
  const pending = pi.proposals.filter((p) => p.status === "pending" && p.kind !== "outcome_draft").sort((x, y) => cmp(x.id, y.id));
  const groups = new Map<ProposalKind, Proposal[]>();
  for (const p of pending) groups.set(p.kind, [...(groups.get(p.kind) ?? []), p]);
  const out: Draft[] = [];
  for (const kind of [...groups.keys()].sort()) {
    const ps = groups.get(kind) ?? [];
    const recs = ps.map((p) => ({ p, r: recommend(p) }));
    const lines = recs.map(({ p, r }) => `- ${p.summary}\n  Recommended: ${r.answer === "accept" ? "accept" : "look at it first"}. ${r.reason}`);
    const evidence = ps.flatMap((p) => p.provenance.slice(0, 1).map(chip)).slice(0, 5);
    const batch = kind !== "conflict" && ps.length >= 2;
    if (batch) {
      out.push({
        projectId: pi.projectId, projectName: pi.projectName, kind: "decide", title: `Decide ${ps.length} ${KIND_WORD[kind]} together`,
        whyNow: `${ps.length} ${KIND_WORD[kind]} are waiting; one answer covers them all.`,
        effort: "review_then_tap", primary: { label: `Accept all ${ps.length}`, op: { op: "accept_proposals", proposalIds: ps.map((p) => p.id) } },
        draft: { kind: "checklist", to: null, subject: null, text: lines.join("\n") }, doneWhen: ["You accepted or rejected them in DAVE"],
        evidence, missing: recs.filter(({ r }) => r.answer === "review").map(({ p, r }) => `${trim(p.summary, 80)}: ${r.reason}`),
        objectiveId: pi.objective?.id ?? null, targetItemIds: ps.map((p) => p.itemId).filter((x): x is string => !!x), uncertain: null,
        base: b, boost: BOOST_BATCH, target: `batch:${kind}`, basis: ps.map((p) => p.id),
      });
      continue;
    }
    for (const { p, r } of recs) {
      out.push({
        projectId: pi.projectId, projectName: pi.projectName, kind: "decide", title: `Decide: ${trim(p.summary)}`,
        whyNow: `Recommended: ${r.answer === "accept" ? "accept" : "look at it first"}. ${r.reason}`,
        effort: r.answer === "accept" ? "one_tap" : "review_then_tap", primary: { label: "Accept", op: { op: "accept_proposal", proposalId: p.id } },
        secondary: [{ label: "Reject", op: { op: "reject_proposal", proposalId: p.id } }],
        draft: p.detail ? { kind: "checklist", to: null, subject: null, text: `${p.summary}\n\n${p.detail}` } : null, doneWhen: ["You accepted or rejected it in DAVE"],
        evidence: p.provenance.slice(0, 3).map(chip), missing: r.answer === "review" ? [r.reason] : [],
        objectiveId: pi.objective?.id ?? null, targetItemIds: p.itemId ? [p.itemId] : [], uncertain: null,
        base: b, boost: 0, target: p.id, basis: [p.id, p.status],
      });
    }
  }
  return out;
}

// ---- chase -------------------------------------------------------------------------------------------------

function chase(pi: ProjectIntel, now: Date, b: number): Draft[] {
  const blockers = pi.items.filter((i) => i.kind === "blocker" && isOpen(i) && (i.owner === "client" || i.owner === "third_party")).sort((x, y) => cmp(x.id, y.id));
  return blockers.map((bl): Draft => {
    const held = [
      ...pi.items.filter((i) => isOpen(i) && i.dependsOn.includes(bl.id)).map((i) => i.title),
      ...pi.plan.waiting.filter((t) => t.waitingMoveId === `chase:${bl.id}`).map((t) => t.build),
    ].filter((t, idx, all) => all.indexOf(t) === idx).sort();
    const waited = daysBetween(bl.createdAt, now);
    const to = bl.owner === "client" ? pi.projectName : "the third party";
    const blocks = held.length ? held.slice(0, 3).map((t) => trim(t, 60)).join(", ") : "the next piece of work";
    const overdue = !!bl.dueDate && bl.dueDate < day(now);
    const text = [
      "Hi,", "",
      `Could you send ${bl.title.replace(/\.$/, "")}? It is holding up ${blocks}, and we have been waiting ${plural(waited, "day")} for it.`,
      "", "Once we have it we can carry on straight away.", "", "Thanks",
    ].join("\n");
    return {
      projectId: pi.projectId, projectName: pi.projectName, kind: "chase", title: `Chase ${bl.owner === "client" ? "the client" : "the third party"}: ${trim(bl.title)}`,
      whyNow: `Waiting ${plural(waited, "day")}; it holds up ${held.length ? plural(held.length, "task") : "the work"}.`,
      effort: "send_draft", primary: { label: "Copy message", op: { op: "copy" } },
      draft: { kind: "message", to, subject: `Waiting on: ${trim(bl.title, 80)}`, text },
      doneWhen: ["They have supplied it", "The blocker is marked done in DAVE"],
      evidence: bl.provenance.slice(0, 3).map(chip), missing: held.length ? [] : ["DAVE could not tell which task this holds up"],
      objectiveId: pi.objective?.id ?? null, targetItemIds: [bl.id], uncertain: null,
      base: b, boost: overdue ? BOOST_OVERDUE : 0, target: bl.id, basis: [bl.id, bl.status, bl.dueDate, held],
    };
  });
}

// ---- follow up on meeting promises ------------------------------------------------------------------------

function followUps(input: PrepareInput, names: Map<string, string>, scores: Map<string, number>, objectives: Map<string, string | null>): Draft[] {
  const today = day(input.now);
  const horizon = day(new Date(input.now.getTime() + FOLLOW_UP_DAYS * DAY_MS));
  return input.promises.filter((p) => p.dueDate && p.dueDate <= horizon).sort((a, b) => cmp(a.id, b.id)).map((p): Draft => {
    const due = p.dueDate ?? today;
    const overdue = due < today;
    const name = p.projectName ?? names.get(p.projectId) ?? p.projectId;
    const what = trim(p.text.replace(/\.$/, ""), 160);
    const draft: PreparedDraft = p.looksDone
      ? { kind: "message", to: name, subject: `Done: ${trim(what, 80)}`, text: `Hi,\n\nAs promised on ${p.meetingAt.slice(0, 10)}: ${what}. It is done and ready for you.\n\nThanks` }
      : { kind: "message", to: name, subject: `Update: ${trim(what, 80)}`, text: `Hi,\n\nA quick update on what I promised on ${p.meetingAt.slice(0, 10)}: ${what}. ${overdue ? "It is running late; I will send it as soon as it is ready." : `It is on track for ${due}.`}\n\nThanks` };
    return {
      projectId: p.projectId, projectName: name, kind: "follow_up",
      title: `${p.looksDone ? "Tell them it shipped" : "Follow up"}: ${trim(p.text)}`,
      whyNow: overdue ? `You promised this for ${due}; it is overdue.` : `You promised this for ${due}.`,
      effort: p.looksDone ? "one_tap" : "send_draft",
      primary: p.looksDone ? { label: "Mark promise done", op: { op: "mark_promise_done", meetingItemId: p.id } } : { label: "Copy message", op: { op: "copy" } },
      secondary: p.looksDone ? [{ label: "Copy message", op: { op: "copy" } }] : [{ label: "Mark promise done", op: { op: "mark_promise_done", meetingItemId: p.id } }],
      draft, doneWhen: ["You delivered it and marked the promise done"],
      evidence: [chipOf(p.meetingTitle, p.meetingAt, "meeting")],
      missing: p.looksDone ? ["Evidence suggests it is done; DAVE has not seen the client confirm it"] : [],
      objectiveId: objectives.get(p.projectId) ?? null, targetItemIds: [], uncertain: null,
      base: scores.get(p.projectId) ?? 0, boost: overdue ? BOOST_OVERDUE : 0, target: p.id, basis: [p.id, p.dueDate, p.looksDone],
    };
  });
}

// ---- plan moves: step, demo, target date, finish line -------------------------------------------------------

function fromMove(pi: ProjectIntel, m: Move, b: number): Draft | null {
  const common = {
    projectId: pi.projectId, projectName: pi.projectName, title: m.title, whyNow: m.why, doneWhen: m.doneWhen,
    objectiveId: pi.objective?.id ?? null, uncertain: null, base: b, boost: 0, target: m.id,
  };
  if (m.kind === "step" && m.step) {
    return { ...common, kind: "step", effort: "one_tap", primary: { label: "Mark reached", op: { op: "mark_step", step: m.step } }, draft: null,
      evidence: [], missing: [], targetItemIds: [], basis: [m.id, pi.plan.progress.steps] };
  }
  if (m.kind === "demo") {
    const seen = pi.plan.progress.lastClientSeenAt;
    const unseen = pi.items.filter((i) => i.evidenceState === "verified" && i.verifiedAt && (!seen || i.verifiedAt > seen)).sort((x, y) => cmp(x.verifiedAt ?? "", y.verifiedAt ?? "") || cmp(x.id, y.id));
    const text = [`Demo for ${pi.projectName}`, "", "Show what is new since they last saw it:", ...unseen.map((i) => `- ${i.title}`), "", "Ask: does this work the way you imagined?"].join("\n");
    return { ...common, kind: "demo", effort: "one_tap", primary: { label: "Shown to the client", op: { op: "mark_demo" } },
      secondary: [{ label: "Copy agenda", op: { op: "copy" } }],
      draft: { kind: "agenda", to: pi.projectName, subject: `Demo: ${pi.projectName}`, text },
      evidence: unseen.slice(0, 5).map((i) => chipOf(i.title, i.verifiedAt, "human")), missing: [], targetItemIds: unseen.map((i) => i.id),
      basis: [m.id, unseen.map((i) => i.id), seen] };
  }
  if (m.kind === "target_date") {
    const date = m.suggestedDate ?? "";
    return { ...common, kind: "target_date", effort: date ? "one_tap" : "review_then_tap",
      primary: { label: date ? `Set ${date}` : "Pick a date", op: { op: "set_target_date", date } }, draft: null,
      evidence: [], missing: date ? [] : ["No agreed date to suggest; pick one"], targetItemIds: [], basis: [m.id, date] };
  }
  if (m.kind === "confirm_finish_line") {
    const draftP = m.proposalId ? pi.proposals.find((p) => p.id === m.proposalId) : undefined;
    if (draftP) {
      return { ...common, kind: "confirm_finish_line", effort: "review_then_tap", primary: { label: "Confirm this finish line", op: { op: "accept_proposal", proposalId: draftP.id } },
        secondary: [{ label: "Reject", op: { op: "reject_proposal", proposalId: draftP.id } }],
        draft: { kind: "checklist", to: null, subject: null, text: `${draftP.summary}${draftP.detail ? `\n\n${draftP.detail}` : ""}` },
        evidence: draftP.provenance.slice(0, 3).map(chip), missing: ["The finish line is DAVE's draft until you confirm it"], targetItemIds: [], basis: [m.id, draftP.id] };
    }
    return { ...common, kind: "confirm_finish_line", effort: "do_yourself", primary: { label: "Copy prompt", op: { op: "copy" } },
      draft: { kind: "checklist", to: null, subject: null, text: `Write down what "works like the client imagined" means for ${pi.projectName}:\n[ ] What the client can do\n[ ] How they will check it` },
      evidence: [], missing: ["Nothing says yet what delivered means here"], targetItemIds: [], basis: [m.id] };
  }
  return null;
}

// ---- assembly ----------------------------------------------------------------------------------------------

export const actionOrder = (a: PreparedAction, b: PreparedAction): number => b.score - a.score || cmp(a.id, b.id);

/** Every prepared action, best first. Pure: the same input always gives the same output. */
export function prepareActions(input: PrepareInput): PreparedAction[] {
  const { now } = input;
  const projects = [...input.projects].sort((a, b) => cmp(a.projectId, b.projectId));
  const names = new Map<string, string>(input.focus.projects.map((p) => [p.projectId, p.projectName]));
  const scores = new Map<string, number>(input.focus.queue.map((o) => [o.projectId, o.score]));
  const objectives = new Map<string, string | null>(input.focus.queue.map((o) => [o.projectId, o.id]));
  for (const pi of projects) { names.set(pi.projectId, pi.projectName); scores.set(pi.projectId, base(pi, input.focus)); objectives.set(pi.projectId, pi.objective?.id ?? null); }
  const drafts: Draft[] = [];
  for (const pi of projects) {
    const b = base(pi, input.focus);
    const reports = input.progress.filter((r) => r.projectId === pi.projectId);
    if (pi.objective) { const d = build(pi, pi.objective, now); if (d) drafts.push(d); }
    const v = verify(pi, reports, now, b); if (v) drafts.push(v);
    const r = retry(pi, reports, b); if (r) drafts.push(r);
    drafts.push(...decide(pi, b), ...chase(pi, now, b));
    for (const m of pi.plan.moves) { const d = fromMove(pi, m, b); if (d) drafts.push(d); }
  }
  drafts.push(...followUps(input, names, scores, objectives));
  const seen = new Set<string>();
  const out: PreparedAction[] = [];
  for (const d of drafts) {
    const a = finish(d, now);
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out.sort(actionOrder);
}

/** Drops actions under an active skip. A skip lapses when the fingerprint changes; a defer lapses after `until`. */
export function applySkips(actions: PreparedAction[], skips: readonly ActiveSkip[], now: Date): { shown: PreparedAction[]; skipped: number } {
  const byId = new Map(skips.map((s) => [s.actionId, s]));
  const shown: PreparedAction[] = [];
  let skipped = 0;
  for (const a of actions) {
    const s = byId.get(a.id);
    const active = !!s && (s.kind === "defer" ? !!s.until && Date.parse(s.until) > now.getTime() : s.fingerprint === a.fingerprint && (!s.until || Date.parse(s.until) > now.getTime()));
    if (active) skipped += 1; else shown.push(a);
  }
  return { shown, skipped };
}
