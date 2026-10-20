/**
 * The next service: prepared actions (GET /api/intel/next), acting on them (POST .../act) and the briefing.
 * Every op changes only DAVE's own records through the existing intel and meeting functions. `hand_to_ezcoder` is
 * refused: Pew starts EZ Coder after a spoken yes; DAVE never starts work.
 */
import type { Db } from "../db/index.ts";
import { IntelError, type IntelService } from "./service.ts";
import { effectiveStrength } from "../meetings/obligation.ts";
import type { Strength } from "../meetings/obligation.ts";
import type { ItemKind, ItemStatus, MeetingItem } from "../meetings/types.ts";
import type { ProjectIntel } from "./types.ts";
import type { LedgerApi } from "./ledger-types.ts";
import type { ProgressReport } from "../work/types.ts";
import { EXECUTION_OPS, NEXT_QUEUE_MAX, type Briefing, type BriefingCaller, type NextActResult, type NextState, type PreparedAction, type PreparedOp, type PreparedOpName } from "./next-types.ts";
import { applySkips, prepareActions, type PromiseInput } from "./prepare.ts";
import { buildBriefing } from "./briefing.ts";

export class NextError extends Error {
  readonly statusCode: 400 | 404 | 409;
  constructor(statusCode: NextError["statusCode"], message: string) { super(message); this.statusCode = statusCode; }
}

export const REFUSE_EXECUTION = "Pew starts EZ Coder after you say yes; DAVE never starts work";
/** Projects prepared per call (focus order). */
const PROJECTS_MAX = 10;
const PROGRESS_DAYS = 7;
const DAY_MS = 86_400_000;

/** The part of MeetingService the next service uses. */
export type NextMeetings = {
  items(filter: { kinds: ItemKind[]; statuses: ItemStatus[] }): MeetingItem[];
  setItemStatus(id: string, action: unknown): MeetingItem;
};

export type NextServiceOptions = {
  db: Db;
  intel: IntelService;
  meetings: NextMeetings;
  work: { progress(query: { since?: string; projectId?: string; limit?: number }): ProgressReport[] };
  ledger: LedgerApi;
  now: () => Date;
};

export type NextActBody = { op: PreparedOpName; note?: string; date?: string };

export type NextService = {
  next(): NextState;
  act(actionId: string, body: NextActBody): NextActResult;
  briefing(query: { since?: string; caller?: BriefingCaller }): Briefing;
};

const strengthOf = (i: MeetingItem & { strength?: Strength | null }): Strength =>
  effectiveStrength({ strength: i.strength ?? null, kind: i.kind, text: i.text, quote: i.quote });

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (v: string): boolean => DATE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

function rethrow(e: unknown): never {
  if (e instanceof NextError) throw e;
  if (e instanceof IntelError) throw new NextError(e.code === "not-found" ? 404 : e.code === "conflict" ? 409 : 400, e.message);
  if (e instanceof Error && "statusCode" in e && (e.statusCode === 400 || e.statusCode === 404 || e.statusCode === 409)) throw new NextError(e.statusCode, e.message);
  throw e;
}

export function createNextService(opts: NextServiceOptions): NextService {
  const { db, intel, meetings, work, ledger } = opts;

  function promises(): PromiseInput[] {
    let items: MeetingItem[] = [];
    try { items = meetings.items({ kinds: ["commitment"], statuses: ["open", "looks_done"] }); } catch { items = []; }
    return items.filter((i) => i.projectId && i.dueDate && strengthOf(i) === "firm").map((i) => ({
      id: i.id, projectId: i.projectId ?? "", projectName: i.projectName, text: i.text, dueDate: i.dueDate,
      meetingTitle: i.meetingTitle, meetingAt: i.meetingAt, looksDone: i.status === "looks_done" && i.suggestedStatus === "done",
    }));
  }

  function prepareAll(): PreparedAction[] {
    const now = opts.now();
    const focus = intel.focus();
    const projects: ProjectIntel[] = [];
    for (const row of focus.projects.slice(0, PROJECTS_MAX)) {
      try { projects.push(intel.projectIntel(row.projectId)); } catch { /* vanished between calls */ }
    }
    let progress: ProgressReport[] = [];
    try { progress = work.progress({ since: new Date(now.getTime() - PROGRESS_DAYS * DAY_MS).toISOString(), limit: 50 }); } catch { progress = []; }
    return prepareActions({ now, focus, projects, promises: promises(), progress });
  }

  function stateOf(all: PreparedAction[]): NextState {
    const now = opts.now();
    const { shown, skipped } = applySkips(all, ledger.activeSkips(), now);
    const queue = shown.slice(0, NEXT_QUEUE_MAX);
    return { generatedAt: now.toISOString(), action: queue[0] ?? null, queue, skipped };
  }

  function next(): NextState { return stateOf(prepareAll()); }

  function offered(a: PreparedAction, name: PreparedOpName): PreparedOp | null {
    return [a.primary.op, ...a.secondary.map((s) => s.op)].find((o) => o.op === name) ?? null;
  }

  function dispatch(a: PreparedAction, op: PreparedOp, body: NextActBody): string {
    const note = body.note ?? null;
    switch (op.op) {
      case "accept_proposal": intel.resolveProposal(op.proposalId, true, note); return "Accepted";
      case "reject_proposal": intel.resolveProposal(op.proposalId, false, note); return "Rejected";
      case "accept_proposals": intel.resolveProposals(op.proposalIds, true, note); return `Accepted ${op.proposalIds.length}`;
      case "mark_step": intel.setStep(a.projectId, op.step, true); return "Step marked reached";
      case "set_target_date": {
        const date = body.date ?? op.date;
        if (!validDay(date)) throw new NextError(400, "Pick a target date (YYYY-MM-DD)");
        intel.setSchedule(a.projectId, { targetDate: date });
        return `Target date set to ${date}`;
      }
      case "mark_demo": intel.markDemo(a.projectId); return "Marked as shown to the client";
      case "mark_promise_done": meetings.setItemStatus(op.meetingItemId, "done"); return "Promise marked done";
      case "mark_verified": intel.verifyItem(op.itemId); return "Marked verified";
      // Nothing to record: the copy itself happens on screen. Say where the draft is, so a voice caller isn't told "Copied".
      case "copy": return a.draft ? `The ${a.draft.kind} is ready to copy in DAVE` : "Ready to copy in DAVE";
      case "hand_to_ezcoder": throw new NextError(409, REFUSE_EXECUTION);
      case "skip":
        ledger.skip({ actionId: a.id, projectId: a.projectId, objectiveId: a.objectiveId, kind: "skip", reason: note, until: null, fingerprint: a.fingerprint });
        return "Skipped";
      case "defer": {
        const raw = body.date ?? op.until;
        const until = DATE.test(raw) ? (validDay(raw) ? `${raw}T00:00:00.000Z` : "") : raw;
        if (!until || !Number.isFinite(Date.parse(until)) || Date.parse(until) <= opts.now().getTime()) throw new NextError(400, "Pick a later date");
        const iso = new Date(Date.parse(until)).toISOString();
        ledger.skip({ actionId: a.id, projectId: a.projectId, objectiveId: a.objectiveId, kind: "defer", reason: note, until: iso, fingerprint: a.fingerprint });
        return `Put off until ${iso.slice(0, 10)}`;
      }
    }
  }

  function act(actionId: string, body: NextActBody): NextActResult {
    if (EXECUTION_OPS.includes(body.op)) throw new NextError(409, REFUSE_EXECUTION);
    const a = prepareAll().find((x) => x.id === actionId);
    if (!a) throw new NextError(409, "This action changed or is gone. Refresh to see the current one.");
    const op = offered(a, body.op);
    if (!op) throw new NextError(400, "That step is not offered for this action");
    let summary: string;
    try { summary = dispatch(a, op, body); } catch (e) { rethrow(e); }
    ledger.markActed({ actionId: a.id, objectiveId: a.objectiveId, projectId: a.projectId, op: body.op, note: body.note ?? null });
    return { ok: true, actionId: a.id, op: body.op, summary, next: next() };
  }

  function briefing(query: { since?: string; caller?: BriefingCaller }): Briefing {
    if (query.since !== undefined && !Number.isFinite(Date.parse(query.since))) throw new NextError(400, "Invalid since");
    return buildBriefing({
      db, now: opts.now(), state: next(), decisionsWaiting: intel.store.pendingProposals().length,
      progress: (q) => { try { return work.progress(q); } catch { return []; } }, since: query.since, caller: query.caller,
    });
  }

  return { next, act, briefing };
}
