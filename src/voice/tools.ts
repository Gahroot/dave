/**
 * Voice tools: JSON-schema definitions for the Realtime model and the server-side executor.
 * Writes are two-step and enforced here: the first call prepares and stores the exact action under a single-use
 * token; only a confirmed second call (or a click on the confirm card) runs it. Every model-facing string goes
 * through speakable(). Meeting quotes, transcripts and Provenance.quote are never read.
 */
import { IntelError } from "../intel/service.ts";
import type { IntelItem, ItemKind, Lane, MarkableStep, Owner, ProjectIntel } from "../intel/types.ts";
import type { DocumentService } from "../documents/types.ts";
import type { MeetingItem } from "../meetings/types.ts";
import type { AttentionAction } from "../shared/types.ts";
import { routeLink } from "../ui/navigation.ts";
import type { ActionCard, CardTone, ConfirmClickRequest, DataScope, DocumentMeta, ToolCallRequest, ToolCallResponse, UiDirective } from "./types.ts";
import { LIMITS } from "./types.ts";
import type { ProjectList, VoiceIntel, VoiceMeetings, VoicePortfolio, VoiceTriage } from "./deps.ts";
import { BUCKET_LABEL, MAX_APPLY_KEYS, TRIAGE_BUCKETS, TRIAGE_KEY, type TriageBucket, type TriageFilter } from "../triage/types.ts";
import type { ToolDefinition } from "./session-config.ts";
import type { ConfirmStore } from "./confirm.ts";
import type { ActionStatus, VoiceStore } from "./store.ts";
import { resolveItem, resolveNamed } from "./resolve.ts";
import { speakable } from "./safety.ts";
import { projectGaps } from "./context.ts";

// ---- definitions -------------------------------------------------------------------------------------------

type Props = Record<string, Record<string, unknown>>;
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const PROJECT = str("Project name as the user said it (or its id from an earlier result). Optional when the user is looking at a project.");
const ITEM = str("Item title as the user said it, or its id from an earlier result.");
const MEETING = str("Meeting title as the user said it, to scope to one recent meeting.");
const strList = (description: string, maxItems = 20) => ({ type: "array", items: { type: "string" }, maxItems, description });

function def(name: string, description: string, props: Props = {}, required: string[] = []): ToolDefinition {
  return { name, description, parameters: { type: "object", properties: props, required, additionalProperties: false } };
}
const CONFIRM_PROPS: Props = {
  confirmToken: str("Only on the second call: the confirmToken from the prepared result."),
  userConfirmed: { type: "boolean", description: "Only on the second call: true when the user said yes, false when they said no." },
};
function write(name: string, description: string, props: Props, required: string[]): ToolDefinition {
  return def(name, `${description} Two steps: the first call prepares and returns a "say" line to read once and ask "Okay?". Then call again with only confirmToken and userConfirmed.`, { ...props, ...CONFIRM_PROPS }, []);
  // `required` documents first-call needs; none is schema-required because the confirm call sends only the token.
  void required;
}

export const READ_TOOL_DEFS: readonly ToolDefinition[] = [
  def("portfolio_overview", "DAVE's recommended order of projects with finish line, paid when, priority, how far behind and next move."),
  def("alignment_check", "Gaps between what the user wants and DAVE's records: missing finish line, paid when or target date, focus filed as extra, a top pick unrelated to the focus, stale data.", { project: PROJECT }),
  def("list_projects", "Every project DAVE knows, by name."),
  def("project_details", "One project: finish line, acceptance, paid when, priority, what matters most, progress, DAVE's next pick, open items.", { project: PROJECT }),
  def("whats_next", "DAVE's recommended next objectives, across the portfolio or for one project.", { project: PROJECT }),
  def("list_decisions", "Decisions waiting for the user (proposed changes to the plan).", { project: PROJECT }),
  def("inbox", "Open Inbox items that need the user."),
  def("meeting_promises", "Open promises and asks from client meetings, in DAVE's own words.", { project: PROJECT }),
  def("recent_changes", "What changed recently in DAVE's records and why the recommendation moved.", { project: PROJECT }),
  def("diagnostics", "Health of DAVE's sources (meetings, git scan, delivery plans)."),
  def("list_documents", "Files the user shared with DAVE.", { project: PROJECT }),
  def("read_document", "Read a window of a shared document's text. Use page for PDFs or offset to continue.", { document: str("Document name or id."), page: { type: "integer", minimum: 1 }, offset: { type: "integer", minimum: 0 } }, ["document"]),
  def("finish_line_from_document", "Find deliverables and acceptance criteria in a shared contract or proposal, to offer them as the finish line.", { document: str("Document name or id.") }, ["document"]),
  def("voice_history", "Summaries of recent voice sessions."),
  def("prepare_ezcoder_tasks", "Put the project's ready EZcoder tasks on screen as a copy card. The task text is shown to the user only.", { project: PROJECT }),
  def("find_noise", "Count the noise DAVE could clear: overdue or stale meeting promises, items that look done, old client asks, drafted decisions and ideas that never became promises, with counts per project and a few examples.", {
    project: PROJECT, meeting: MEETING, bucket: { type: "string", enum: [...TRIAGE_BUCKETS] }, text: str("Only items containing these words."),
    olderThanDays: { type: "integer", minimum: 0, maximum: 3650, description: "Only items from meetings at least this many days old." },
    includeConfirmed: { type: "boolean", description: "Also items the user already acted on." },
  }),
  def("refresh_everything", "Pull fresh updates: rescan projects, re-check delivery and sync meetings when connected. Slow; only when asked."),
];

export const WRITE_TOOL_DEFS: readonly ToolDefinition[] = [
  write("set_finish_line", "Set the project's finish line in the client's terms, with 2 to 5 acceptance criteria and optionally paid when.", { project: PROJECT, finishLine: str("What the client can do when it is done."), acceptance: strList("2 to 5 checkable acceptance criteria."), paidWhen: str("What triggers payment.") }, ["finishLine"]),
  write("edit_acceptance", "Replace the acceptance criteria of a confirmed finish line.", { project: PROJECT, acceptance: strList("The full new list.") }, ["acceptance"]),
  write("set_paid_when", "Set or clear what triggers payment.", { project: PROJECT, paidWhen: { type: ["string", "null"], description: "null clears it." } }, ["paidWhen"]),
  write("set_priority", "Rank the project 1 (most important) to 5, or null to clear.", { project: PROJECT, priority: { type: ["integer", "null"], minimum: 1, maximum: 5 } }, ["priority"]),
  write("set_focus", "Change what matters most now for a project (its focus items).", { project: PROJECT, mode: { type: "string", enum: ["replace", "add", "remove"] }, items: strList("Item titles or ids.", 10) }, ["items"]),
  write("set_target_date", "Set or clear the target delivery date (YYYY-MM-DD). Needs a confirmed finish line.", { project: PROJECT, date: { type: ["string", "null"] } }, ["date"]),
  write("add_item", "Add an item to the project's records.", { project: PROJECT, kind: { type: "string", enum: ["requirement", "milestone", "commitment", "blocker", "decision", "exclusion"] }, title: str("Short title."), dueDate: str("YYYY-MM-DD"), owner: { type: "string", enum: ["me", "client", "third_party", "unknown"] } }, ["kind", "title"]),
  write("update_item", "Change an item's title, status, due date, owner, lane or goal.", { project: PROJECT, item: ITEM, title: str("New title."), status: { type: "string", enum: ["open", "in_progress", "done", "dropped"] }, dueDate: { type: ["string", "null"] }, owner: { type: "string", enum: ["me", "client", "third_party", "unknown"] }, lane: { type: "string", enum: ["finish_line", "extra", "phase2"] }, goal: str("So that ...") }, ["item"]),
  write("verify_item", "Mark an item verified (the user checked it works).", { project: PROJECT, item: ITEM }, ["item"]),
  write("reopen_item", "Reopen an item that is not right.", { project: PROJECT, item: ITEM, note: str("What is wrong.") }, ["item"]),
  write("resolve_decision", "Accept or reject a waiting decision.", { decision: str("Decision summary or id."), accept: { type: "boolean" }, note: str("Optional note.") }, ["decision", "accept"]),
  write("mark_step", "Mark a delivery step reached or not: live, using (client using it), signed_off.", { project: PROJECT, step: { type: "string", enum: ["live", "using", "signed_off"] }, reached: { type: "boolean" } }, ["step", "reached"]),
  write("mark_shown_to_client", "Record that the latest work was shown to the client today.", { project: PROJECT }, []),
  write("add_finish_line_items", "Add finish-line items (for example from a contract) and optional acceptance criteria.", { project: PROJECT, items: strList("Item titles."), acceptance: strList("Acceptance criteria.") }, ["items"]),
  write("inbox_action", "Handle, snooze to tomorrow or dismiss an Inbox item.", { item: str("Inbox item title or id."), action: { type: "string", enum: ["handled", "tomorrow", "dismiss"] } }, ["item", "action"]),
  write("meeting_item_action", "Set a meeting promise or ask to done, dropped or open, or answer a looks-done suggestion (confirm / not_yet).", { item: str("Item text or id."), action: { type: "string", enum: ["done", "dropped", "open", "confirm", "not_yet"] } }, ["item", "action"]),
  write("promote_idea", "Turn a meeting idea (a maybe, not a promise) into a real promise, so it counts in the plan again.", { item: str("Idea text or id.") }, ["item"]),
  write("demote_promise", "Mark a meeting promise as just an idea, so it stops counting as a promise.", { item: str("Promise text or id.") }, ["item"]),
  write("pin_project", "Pin or unpin a project so it stays in Active.", { project: PROJECT, pinned: { type: "boolean" } }, ["pinned"]),
  write("forget_note", "Delete a note DAVE remembers.", { note: str("Note text or id.") }, ["note"]),
  write("clean_up", "Clear (or mark done) noisy meeting promises, old client asks and drafted decisions in one go. Exactly the items matched when prepared are changed; every clean-up can be undone.", {
    buckets: { type: "array", items: { type: "string", enum: [...TRIAGE_BUCKETS] }, maxItems: TRIAGE_BUCKETS.length, description: "Which kinds of noise (from find_noise)." },
    project: PROJECT, meeting: MEETING, text: str("Only items whose title, project or meeting contains these words."),
    olderThanDays: { type: "integer", minimum: 0, maximum: 3650 }, overdueOnly: { type: "boolean" },
    includeConfirmed: { type: "boolean", description: "Also items the user already acted on. Off by default." },
    keys: strList("Exact item keys from find_noise.", 200), action: { type: "string", enum: ["clear", "done"], description: "clear (default) or done." },
  }, []),
];

export const IMMEDIATE_TOOL_DEFS: readonly ToolDefinition[] = [
  def("remember", "Keep a note of what the user told DAVE (it shapes the ranking). Immediate.", { text: str("The note, in plain words."), project: PROJECT }, ["text"]),
  def("attach_document", "Attach a shared document to a project (or null to detach). Immediate.", { document: str("Document name or id."), project: { type: ["string", "null"] } }, ["document"]),
  def("open_page", "Show a page of the DAVE app.", { page: { type: "string", enum: ["focus", "queue", "projects", "meetings", "cleanup", "connections", "issues"] }, project: PROJECT, section: { type: "string", enum: ["promises", "asks", "list", "instructions"] } }, ["page"]),
  def("end_session", "End the voice session when the user is done."),
  def("approve_session", "Turn Approve all for this session on (only when the user themselves just said so, for example 'you have my approval') or off ('ask me again'). While on, write tools apply without asking.", { on: { type: "boolean" } }, ["on"]),
  def("undo_clean_up", "Undo the latest clean-up (restores the cleared items). Immediate."),
];

export const VOICE_TOOLS: readonly ToolDefinition[] = [...READ_TOOL_DEFS, ...WRITE_TOOL_DEFS, ...IMMEDIATE_TOOL_DEFS];
export const VOICE_TOOL_NAMES: ReadonlySet<string> = new Set(VOICE_TOOLS.map((t) => t.name));
const WRITE_NAMES: ReadonlySet<string> = new Set(WRITE_TOOL_DEFS.map((t) => t.name));

// ---- executor ----------------------------------------------------------------------------------------------

export type ToolDeps = {
  intel: VoiceIntel;
  meetings: VoiceMeetings;
  portfolio: VoicePortfolio;
  documents: DocumentService;
  projects: ProjectList;
  triage: VoiceTriage;
  store: VoiceStore;
  confirms: ConfirmStore<PreparedAction>;
  now: () => Date;
};

type Done = { response: ToolCallResponse; status: ActionStatus; summary: string };
export type PreparedAction = { run: () => Promise<Done> | Done };
type Prepared = { confirm: { title: string; say: string; details: string[]; run: () => Promise<Done> | Done } };
type Result = Done | Prepared;
/**
 * autoApprove: Approve all is on for this session, so prepared writes run at once.
 * batches: the session's clean-up batch ids (oldest first); clean_up appends, undo_clean_up reads.
 */
export type Ctx = { sessionId: string; projectId: string | null; autoApprove: boolean; batches?: string[] };
type Args = Record<string, unknown>;

/** A user-facing refusal (bad args, ambiguity). Caught inside the executor; never escapes. */
class Refusal extends Error {
  readonly output: Record<string, unknown>;
  constructor(say: string, output: Record<string, unknown> = {}) { super(say); this.output = output; }
}

const sp = (t: string | null | undefined, max = 300): string => speakable(t ?? "", max);
const card = (tone: CardTone, title: string, detail?: string, link?: string): ActionCard => ({ tone, title: sp(title, 120), ...(detail ? { detail: sp(detail, 240) } : {}), ...(link ? { link } : {}) });
const json = (o: unknown): string => JSON.stringify(o);

function read(output: Record<string, unknown>, title: string, tone: CardTone = "gray", ui?: UiDirective): Done {
  return { response: { ok: true, output: json(output), card: card(tone, title), ...(ui ? { ui } : {}) }, status: "done", summary: `Read: ${title}` };
}
function done(say: string, scopes: DataScope[], title: string, extra: Partial<ToolCallResponse> = {}): Done {
  const s = sp(say);
  return { response: { ok: true, output: json({ done: true, say: s }), card: card("green", title, s), ui: { refresh: scopes }, ...extra }, status: "done", summary: s };
}
function failure(message: string, status: ActionStatus, extra: Record<string, unknown> = {}): Done {
  const m = sp(message);
  return { response: { ok: false, output: json({ error: m, ...extra }), error: m, card: card("red", status === "refused" ? "DAVE couldn't do that" : "That didn't work", m) }, status, summary: `Failed: ${m}` };
}

// argument readers
function text(a: Args, key: string, max: number, required: true): string;
function text(a: Args, key: string, max: number, required?: false): string | undefined;
function text(a: Args, key: string, max: number, required = false): string | undefined {
  const v = a[key];
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) { if (required) throw new Refusal(`I need the ${key} for that.`); return undefined; }
  if (typeof v !== "string") throw new Refusal(`The ${key} should be words.`);
  if (v.length > max) throw new Refusal(`The ${key} is too long.`);
  return v.trim();
}
function list(a: Args, key: string, maxItems: number, maxLen: number, required = false): string[] | undefined {
  const v = a[key];
  if (v === undefined) { if (required) throw new Refusal(`I need the ${key} for that.`); return undefined; }
  if (!Array.isArray(v) || v.length > maxItems || !v.every((x) => typeof x === "string" && x.trim().length > 0 && x.length <= maxLen)) throw new Refusal(`The ${key} should be a short list of short phrases.`);
  return v.map((x: string) => x.trim());
}
function bool(a: Args, key: string): boolean {
  const v = a[key];
  if (typeof v !== "boolean") throw new Refusal(`I need a yes or no for ${key}.`);
  return v;
}
function oneOf<T extends string>(a: Args, key: string, allowed: readonly T[], fallback?: T): T {
  const v = a[key];
  if (v === undefined && fallback !== undefined) return fallback;
  const hit = allowed.find((x) => x === v);
  if (!hit) throw new Refusal(`The ${key} must be one of: ${allowed.join(", ")}.`);
  return hit;
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string): boolean => DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const join = (xs: string[]): string => xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`;

export function createToolExecutor(deps: ToolDeps) {
  const { intel } = deps;

  function projectOf(a: Args, ctx: Ctx, key = "project", required = true): { id: string; name: string } | null {
    const q = text(a, key, 200);
    const all = deps.projects();
    if (!q) {
      if (ctx.projectId) { const hit = all.find((p) => p.id === ctx.projectId); if (hit) return hit; }
      if (required) throw new Refusal("Which project do you mean?", { needsProject: true });
      return null;
    }
    const r = resolveNamed(q, all);
    if ("project" in r) return r.project;
    if ("ambiguous" in r) throw new Refusal(`Which one: ${join(r.candidates.map((c) => sp(c, 60)))}?`, { ambiguous: true, candidates: r.candidates.map((c) => sp(c, 60)) });
    throw new Refusal(`I couldn't find a project called ${sp(q, 60)}.`, { notFound: true });
  }
  function itemOf(pi: ProjectIntel, q: string): IntelItem {
    const r = resolveItem(q, pi.items);
    if ("project" in r) return r.project;
    if ("ambiguous" in r) throw new Refusal(`Which item: ${join(r.candidates.map((c) => sp(c, 80)))}?`, { ambiguous: true, candidates: r.candidates.map((c) => sp(c, 80)) });
    throw new Refusal(`I couldn't find "${sp(q, 80)}" in ${sp(pi.projectName, 60)}.`, { notFound: true });
  }
  function documentOf(q: string): DocumentMeta {
    const docs = deps.documents.list({ limit: 200 });
    const r = resolveNamed(q, docs);
    if ("project" in r) return r.project;
    if ("ambiguous" in r) throw new Refusal(`Which document: ${join(r.candidates.map((c) => sp(c, 80)))}?`, { ambiguous: true, candidates: r.candidates.map((c) => sp(c, 80)) });
    throw new Refusal("I couldn't find that document.", { notFound: true });
  }
  const docOut = (d: DocumentMeta) => ({ documentId: d.id, name: sp(d.name, 120), kind: d.kind, pages: d.pages, textState: d.textState, project: d.projectName ? sp(d.projectName, 60) : null, deliverablesFound: d.agreementCandidates });
  const confirm = (title: string, say: string, details: string[], run: () => Promise<Done> | Done): Prepared => ({ confirm: { title: sp(title, 120), say: sp(say), details: details.map((d) => sp(d, 200)).slice(0, 8), run } });

  const CLEANUP_SCOPES: DataScope[] = ["meetings", "intel", "portfolio"];
  function bucketList(a: Args): TriageBucket[] | undefined {
    const v = a.buckets;
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.length > TRIAGE_BUCKETS.length) throw new Refusal("The buckets should be a short list.");
    return v.map((x) => { const hit = TRIAGE_BUCKETS.find((b) => b === x); if (!hit) throw new Refusal(`The buckets must be some of: ${TRIAGE_BUCKETS.join(", ")}.`); return hit; });
  }
  function optBool(a: Args, key: string): boolean | undefined { return a[key] === undefined ? undefined : bool(a, key); }
  /** Only an explicitly named project narrows a clean-up; the page's project does not. */
  const namedProject = (a: Args, ctx: Ctx) => a.project === undefined || a.project === null ? null : projectOf(a, ctx);
  /** A spoken meeting title, matched among the latest 50 meetings. Ambiguous: ask which. None: say so. */
  function meetingOf(a: Args): { id: string; name: string } | null {
    const q = text(a, "meeting", 200);
    if (!q) return null;
    const r = resolveNamed(q, deps.meetings.recentMeetings(50).map((m) => ({ id: m.recordingId, name: m.title })));
    if ("project" in r) return r.project;
    if ("ambiguous" in r) throw new Refusal(`Which meeting: ${join(r.candidates.map((c) => sp(c, 80)))}?`, { ambiguous: true, candidates: r.candidates.map((c) => sp(c, 80)) });
    throw new Refusal(`I couldn't find a recent meeting called ${sp(q, 80)}.`, { notFound: true });
  }
  function olderThan(a: Args): number | undefined {
    const older = a.olderThanDays;
    if (older === undefined) return undefined;
    if (typeof older !== "number" || !Number.isInteger(older) || older < 0 || older > 3650) throw new Refusal("olderThanDays should be a whole number of days.");
    return older;
  }
  /** Counts per project, largest first, then by name. */
  function perProject(entries: readonly { projectName: string | null }[]): { project: string; count: number }[] {
    const m = new Map<string, number>();
    for (const e of entries) { const k = e.projectName ? sp(e.projectName, 60) : "No project"; m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m].map(([project, count]) => ({ project, count })).sort((x, y) => y.count - x.count || x.project.localeCompare(y.project));
  }
  function strengthOf(i: MeetingItem): "firm" | "tentative" | null {
    if (!("strength" in i)) return null;
    return i.strength === "firm" || i.strength === "tentative" ? i.strength : null;
  }
  function setStrength(a: Args, to: "firm" | "tentative"): Prepared {
    const q = text(a, "item", 300, true);
    const all = deps.meetings.items({ kinds: ["commitment", "suggestion", "pain_point", "decision"], statuses: ["open", "planned", "looks_done"] });
    const items = all.filter((i) => strengthOf(i) !== to);
    const r = resolveNamed(q, items.map((i) => ({ id: i.id, name: i.text })));
    if ("ambiguous" in r) throw new Refusal(`Which one: ${join(r.candidates.map((c) => sp(c, 80)))}?`, { ambiguous: true });
    if ("none" in r) throw new Refusal(to === "firm" ? "I couldn't find that idea in your meetings." : "I couldn't find that promise in your meetings.", { notFound: true });
    const it = r.project;
    const verb = to === "firm" ? "Make this a promise" : "Mark this as just an idea";
    return confirm(to === "firm" ? "Promote idea" : "Demote promise", `${verb}: ${it.name}.`, [it.name], () => {
      deps.meetings.setItemStrength(it.id, to);
      return done(to === "firm" ? `It's a promise now: ${it.name}.` : `Now just an idea: ${it.name}.`, ["meetings", "intel", "portfolio"], to === "firm" ? "Promoted to a promise" : "Marked as an idea");
    });
  }

  const handlers: Record<string, (a: Args, ctx: Ctx) => Promise<Result> | Result> = {
    find_noise: (a, ctx) => {
      const p = namedProject(a, ctx);
      const m = meetingOf(a);
      const bucket = a.bucket === undefined ? undefined : oneOf(a, "bucket", TRIAGE_BUCKETS);
      const t = text(a, "text", 200);
      const older = olderThan(a);
      const inc = optBool(a, "includeConfirmed");
      const filter: TriageFilter = { ...(p ? { projectId: p.id } : {}), ...(m ? { recordingId: m.id } : {}), ...(bucket ? { buckets: [bucket] } : {}), ...(t ? { text: t } : {}),
        ...(older !== undefined ? { olderThanDays: older } : {}), ...(inc !== undefined ? { includeConfirmed: inc } : {}) };
      const pv = deps.triage.preview(filter);
      const counts = TRIAGE_BUCKETS.filter((b) => pv.counts[b] > 0).map((b) => ({ bucket: b, label: BUCKET_LABEL[b], count: pv.counts[b] }));
      const samples = pv.entries.slice(0, 15).map((e) => ({ key: e.key, title: sp(e.title, 160), project: e.projectName ? sp(e.projectName, 60) : null, reason: sp(e.reasons[0] ?? BUCKET_LABEL[e.bucket], 120) }));
      return read({ total: pv.total, counts, byProject: perProject(pv.entries), ...(m ? { meeting: sp(m.name, 80) } : {}), samples, confirmedHidden: pv.confirmedHidden, hint: pv.total > 0 ? "Offer to clear them in one go." : "Nothing noisy to clear." },
        pv.total > 0 ? `${pv.total} item${pv.total === 1 ? "" : "s"} to clean up` : "Nothing to clean up", pv.total > 0 ? "amber" : "gray");
    },
    clean_up: (a, ctx) => {
      const p = namedProject(a, ctx);
      const m = meetingOf(a);
      const buckets = bucketList(a);
      const t = text(a, "text", 200);
      const older = olderThan(a);
      const overdue = optBool(a, "overdueOnly");
      const inc = optBool(a, "includeConfirmed");
      const keys = list(a, "keys", MAX_APPLY_KEYS, 200);
      if (keys && !keys.every((k) => TRIAGE_KEY.test(k))) throw new Refusal("Those item keys are not valid. Use the keys from find_noise.");
      const action = oneOf(a, "action", ["clear", "done"] as const, "clear");
      const filter: TriageFilter = {
        ...(p ? { projectId: p.id } : {}), ...(m ? { recordingId: m.id } : {}), ...(buckets ? { buckets } : {}), ...(t ? { text: t } : {}), ...(older !== undefined ? { olderThanDays: older } : {}),
        ...(overdue !== undefined ? { overdueOnly: overdue } : {}), ...(inc !== undefined ? { includeConfirmed: inc } : {}), ...(keys ? { keys } : {}),
      };
      const entries = deps.triage.preview(filter).entries.slice(0, MAX_APPLY_KEYS);
      if (entries.length === 0) throw new Refusal("Nothing matches that, so there is nothing to clean up.", { nothingToDo: true });
      // Frozen now: exactly these keys run, whatever changes before the confirm.
      const frozen = entries.map((e) => e.key);
      const n = frozen.length;
      const noun = `${n} item${n === 1 ? "" : "s"}`;
      const title = action === "clear" ? `Clear ${noun}` : `Mark ${noun} done`;
      const details = entries.slice(0, 8).map((e) => e.projectName ? `${e.title} (${e.projectName})` : e.title);
      if (n > 8) details.push(`and ${n - 8} more`);
      const split = perProject(entries);
      const across = split.length > 1 ? ` across ${split.slice(0, 4).map((x) => `${x.count} in ${x.project}`).join(", ")}` : "";
      const say = `${action === "clear" ? "Clear" : "Mark done"} ${noun}${p ? ` for ${p.name}` : ""}${m ? ` from ${m.name}` : ""}${across}, for example ${entries.slice(0, 2).map((e) => e.title).join(" and ")}. It can be undone.`;
      const c = confirm(title, say, [], () => {
        const r = deps.triage.apply({ keys: frozen, action, source: "voice" });
        if (r.batchId === null) return failure(r.summary || "Nothing was changed.", "failed");
        ctx.batches?.push(r.batchId);
        return done(`${r.summary}${r.skipped.length ? ` ${r.skipped.length} left alone.` : ""} Say undo to bring them back.`, CLEANUP_SCOPES, title, { ui: { refresh: CLEANUP_SCOPES, undo: { batchId: r.batchId } } });
      });
      // details: the first 8 titles plus "and N more" (confirm() caps at 8, so set them here).
      return { confirm: { ...c.confirm, details: details.map((d) => sp(d, 200)) } };
    },
    undo_clean_up: (_a, ctx) => {
      const all = deps.triage.batches(100);
      const open = (id: string) => all.find((b) => b.id === id && b.undoneAt === null);
      const mine = [...(ctx.batches ?? [])].reverse().map(open).find((b) => b !== undefined);
      const target = mine ?? all.find((b) => b.undoneAt === null);
      if (!target) throw new Refusal("There is no clean-up to undo.");
      const r = deps.triage.undo(target.id);
      if (!r) throw new Refusal("That clean-up is gone.");
      const skipped = r.skipped ? ` ${r.skipped} had changed since, so DAVE left them.` : "";
      return done(`Restored ${r.restored} item${r.restored === 1 ? "" : "s"} from: ${target.summary}${skipped}`, CLEANUP_SCOPES, "Clean-up undone");
    },
    approve_session: () => failure("Approve all is handled by the voice session.", "refused"),
    portfolio_overview: () => {
      const f = intel.focus();
      const projects = f.projects.slice(0, 8).map((r) => {
        const d = intel.direction(r.projectId);
        return { projectId: r.projectId, name: sp(r.projectName, 60), finishLine: r.outcome ? sp(r.outcome, 200) : null, paidWhen: d.paidWhen ? sp(d.paidWhen, 160) : null, priority: d.priority,
          behindScore: r.delivery.behind?.score ?? null, percentDone: r.delivery.percentDone, nextMove: r.nextMove ? sp(r.nextMove, 160) : null };
      });
      return read({ note: "This order is DAVE's recommendation.", projects, decisionsWaiting: f.decisions.length, noFinishLine: f.projects.filter((r) => !r.outcome).map((r) => sp(r.projectName, 60)) }, "DAVE's read of the portfolio", "violet");
    },
    alignment_check: (a, ctx) => {
      const p = projectOf(a, ctx, "project", false);
      const ids = p ? [p.id] : intel.focus().projects.map((r) => r.projectId).slice(0, 10);
      const gaps = ids.flatMap((id) => { try { return projectGaps(intel, id); } catch { return []; } }).slice(0, 15);
      return read({ gaps, aligned: gaps.length === 0 }, p ? `Alignment for ${p.name}` : "Alignment check", "violet");
    },
    list_projects: () => read({ projects: deps.projects().slice(0, 60).map((p) => ({ projectId: p.id, name: sp(p.name, 60) })) }, "Projects"),
    project_details: (a, ctx) => {
      const p = projectOf(a, ctx);
      const pi = intel.projectIntel(p?.id ?? "");
      const titles = new Map(pi.items.map((i) => [i.id, i.title]));
      const open = pi.items.filter((i) => i.status === "open" || i.status === "in_progress").slice(0, 12);
      return read({
        projectId: pi.projectId, name: sp(pi.projectName, 60),
        finishLine: pi.outcome ? sp(pi.outcome.desiredOutcome, 300) : null, finishLineConfirmed: pi.plan.progress.confirmed,
        acceptance: (pi.outcome?.acceptanceCriteria ?? []).slice(0, 10).map((c) => sp(c, 160)),
        paidWhen: pi.direction.paidWhen ? sp(pi.direction.paidWhen, 200) : null, priority: pi.direction.priority,
        mattersMostNow: pi.direction.focusItemIds.map((id) => sp(titles.get(id) ?? "", 120)).filter(Boolean),
        progress: { percentDone: pi.plan.progress.percentDone, step: pi.plan.progress.currentStep, targetDate: pi.plan.progress.targetDate, behindScore: pi.plan.progress.behind?.score ?? null, waitingOnClient: pi.plan.progress.waitingOnClient },
        davesPick: pi.objective ? { objective: sp(pi.objective.objective, 200), whyNow: sp(pi.objective.whyNow, 200) } : null,
        yourMoves: pi.plan.moves.slice(0, 3).map((m) => sp(m.title, 160)),
        openItems: open.map((i) => ({ itemId: i.id, title: sp(i.title, 160), kind: i.kind, status: i.status, lane: i.lane, owner: i.owner, dueDate: i.dueDate })),
        readyTasks: pi.plan.ready.length,
      }, pi.projectName);
    },
    whats_next: (a, ctx) => {
      const p = projectOf(a, ctx, "project", false);
      if (p) {
        const pi = intel.projectIntel(p.id);
        const objs = [pi.objective, ...pi.otherActions].filter((o) => o !== null).slice(0, 3);
        return read({ note: "DAVE's recommendation.", project: sp(pi.projectName, 60), next: objs.map((o) => ({ objective: sp(o.objective, 200), whyNow: sp(o.whyNow, 200) })) }, `Next for ${p.name}`, "violet");
      }
      const f = intel.focus();
      return read({ note: "DAVE's recommendation.", next: f.queue.slice(0, 3).map((o) => ({ projectId: o.projectId, project: sp(o.projectName, 60), objective: sp(o.objective, 200), whyNow: sp(o.whyNow, 200) })) }, "What's next", "violet");
    },
    list_decisions: (a, ctx) => {
      const p = projectOf(a, ctx, "project", false);
      const ds = intel.focus().decisions.filter((d) => !p || d.projectId === p.id).slice(0, 8);
      return read({ decisions: ds.map((d) => ({ decisionId: d.id, project: sp(d.projectName, 60), kind: d.kind, summary: sp(d.summary, 200) })) }, "Decisions waiting");
    },
    inbox: async () => {
      const pf = await deps.portfolio.current();
      const open = pf.inbox.filter((i) => i.status === "open").slice(0, 8);
      return read({ items: open.map((i) => ({ itemId: i.id, project: i.projectName ? sp(i.projectName, 60) : null, title: sp(i.title, 160), nextStep: sp(i.nextStep, 160) })) }, "Inbox");
    },
    meeting_promises: (a, ctx) => {
      const p = projectOf(a, ctx, "project", false);
      const items = deps.meetings.items({ kinds: ["commitment", "suggestion"], statuses: ["open", "planned", "looks_done"] }).filter((i) => !p || i.projectId === p.id).slice(0, 10);
      // DAVE's own wording only (text), never the quote.
      return read({ items: items.map((i) => ({ itemId: i.id, kind: i.kind === "commitment" ? "promise" : "ask", project: i.projectName ? sp(i.projectName, 60) : null, text: sp(i.text, 200), dueDate: i.dueDate, status: i.status })) }, "Meeting promises");
    },
    recent_changes: (a, ctx) => {
      const p = projectOf(a, ctx, "project", false);
      const changes = p ? intel.projectIntel(p.id).history.slice(0, 8) : intel.focus().recentChanges.slice(0, 8);
      return read({ changes: changes.map((c) => ({ at: c.at.slice(0, 10), summary: sp(c.summary, 200) })) }, "Recent changes");
    },
    diagnostics: () => read({ sources: intel.sourceHealth().map((s) => ({ source: s.source, state: s.state, detail: s.detail ? sp(s.detail, 160) : null })) }, "Source health"),
    list_documents: (a, ctx) => {
      const p = projectOf(a, ctx, "project", false);
      const docs = deps.documents.list(p ? { projectId: p.id, limit: 20 } : { limit: 20 });
      return read({ documents: docs.map(docOut) }, "Shared documents");
    },
    read_document: (a) => {
      const d = documentOf(text(a, "document", 300, true));
      const page = a.page === undefined ? undefined : Number.isSafeInteger(a.page) && Number(a.page) >= 1 ? Number(a.page) : null;
      const offset = a.offset === undefined ? undefined : Number.isSafeInteger(a.offset) && Number(a.offset) >= 0 ? Number(a.offset) : null;
      if (page === null || offset === null) throw new Refusal("The page or offset is not valid.");
      const r = deps.documents.read(d.id, { ...(page !== undefined ? { page } : {}), ...(offset !== undefined ? { offset } : {}), maxChars: LIMITS.readWindowChars });
      if (!r) return failure(d.textState === "pending" ? "That document is still being read. Try again in a moment." : "DAVE has no text for that document.", "refused");
      return read({ ...docOut(r.document), page: r.page, pages: r.pages, offset: r.offset, nextOffset: r.nextOffset, text: sp(r.text, LIMITS.readWindowChars) }, `Read ${r.document.name}`, "gray", { refresh: [] });
    },
    finish_line_from_document: (a) => {
      const d = documentOf(text(a, "document", 300, true));
      const ag = deps.documents.agreement(d.id);
      if (!ag) return failure("DAVE has no text for that document yet.", "refused");
      return read({ ...docOut(d), deliverables: ag.items.slice(0, 20).map((i) => sp(i.title, 200)), acceptance: ag.acceptance.slice(0, 10).map((c) => sp(c, 200)),
        next: "Offer these as finish-line items; on yes call add_finish_line_items with the chosen titles." }, `Deliverables in ${d.name}`, "violet");
    },
    voice_history: () => read({ sessions: deps.store.history(5).map((h) => ({ date: h.startedAt.slice(0, 10), project: h.projectName ? sp(h.projectName, 60) : null, summary: h.summary ? sp(h.summary, 300) : null })) }, "Recent voice sessions"),
    prepare_ezcoder_tasks: (a, ctx) => {
      const p = projectOf(a, ctx);
      const pi = intel.projectIntel(p?.id ?? "");
      const ready = pi.plan.ready;
      if (!ready.length) return read({ copyCardShown: false, readyTasks: 0, waiting: pi.plan.waiting.length }, `No ready tasks for ${pi.projectName}`);
      const copy = { label: `${ready.length} task${ready.length === 1 ? "" : "s"} for ${pi.projectName}`, text: ready.map((t) => t.text).join("\n\n---\n\n"), projectId: pi.projectId, itemIds: ready.map((t) => t.itemId) };
      // The task text stays in ui.copy (local UI only); briefs can contain client quotes.
      return read({ copyCardShown: true, readyTasks: ready.length, titles: ready.slice(0, 5).map((t) => sp(t.build, 120)), say: "The tasks are on screen. Copying them marks them sent to EZcoder." }, `Tasks for ${pi.projectName}`, "gray", { copy });
    },
    refresh_everything: async () => {
      await deps.portfolio.refresh();
      await intel.reconcile();
      let meetings = "not connected";
      if (deps.meetings.fathomConnected()) { try { deps.meetings.syncNow(); meetings = "syncing"; } catch { meetings = "could not sync"; } }
      return done(`Pulled fresh updates. Meetings: ${meetings}.`, ["portfolio", "intel", "meetings"], "Pulled fresh updates");
    },

    // ---- confirmed writes
    set_finish_line: (a, ctx) => {
      const p = projectOf(a, ctx);
      const finish = text(a, "finishLine", 1000, true);
      const acceptance = list(a, "acceptance", 20, 300) ?? [];
      const paid = text(a, "paidWhen", 500);
      const id = p?.id ?? "";
      const name = p?.name ?? "";
      return confirm(`Finish line for ${name}`, `Set the finish line for ${name}: ${finish}.${acceptance.length ? ` ${acceptance.length} acceptance criteria.` : ""}${paid ? ` Paid when ${paid}.` : ""}`,
        [finish, ...acceptance.map((c) => `Done when: ${c}`), ...(paid ? [`Paid when: ${paid}`] : [])], () => {
          intel.putOutcome(id, { desiredOutcome: finish, acceptanceCriteria: acceptance });
          if (paid) intel.setDirection(id, { paidWhen: paid });
          return done(`Set the finish line for ${name}.`, ["intel"], `Finish line set for ${name}`);
        });
    },
    edit_acceptance: (a, ctx) => {
      const p = projectOf(a, ctx);
      const acceptance = list(a, "acceptance", 20, 300, true) ?? [];
      const pi = intel.projectIntel(p?.id ?? "");
      const outcome = pi.outcome;
      if (!outcome) throw new Refusal(`${pi.projectName} has no finish line yet. Set one first.`);
      return confirm(`Acceptance for ${pi.projectName}`, `Replace the acceptance criteria for ${pi.projectName} with ${acceptance.length} new ones.`, acceptance, () => {
        intel.putOutcome(pi.projectId, { desiredOutcome: outcome.desiredOutcome, acceptanceCriteria: acceptance });
        return done(`Updated the acceptance criteria for ${pi.projectName}.`, ["intel"], "Acceptance updated");
      });
    },
    set_paid_when: (a, ctx) => {
      const p = projectOf(a, ctx);
      const paid = a.paidWhen === null ? null : text(a, "paidWhen", 500, true);
      const id = p?.id ?? "", name = p?.name ?? "";
      return confirm(`Paid when for ${name}`, paid ? `${name} gets paid when ${paid}.` : `Clear when ${name} gets paid.`, paid ? [paid] : [], () => {
        intel.setDirection(id, { paidWhen: paid });
        return done(paid ? `Saved: ${name} gets paid when ${paid}.` : `Cleared paid when for ${name}.`, ["intel"], "Paid when saved");
      });
    },
    set_priority: (a, ctx) => {
      const p = projectOf(a, ctx);
      const v = a.priority;
      if (v !== null && !(Number.isInteger(v) && Number(v) >= 1 && Number(v) <= 5)) throw new Refusal("Priority must be 1 to 5, or none.");
      const priority = v === null ? null : Number(v);
      const id = p?.id ?? "", name = p?.name ?? "";
      return confirm(`Priority for ${name}`, priority === null ? `Clear the priority for ${name}.` : `Make ${name} priority ${priority}.`, [], () => {
        intel.setDirection(id, { priority });
        return done(priority === null ? `Cleared the priority for ${name}.` : `${name} is now priority ${priority}.`, ["intel"], "Priority saved");
      });
    },
    set_focus: (a, ctx) => {
      const p = projectOf(a, ctx);
      const mode = oneOf(a, "mode", ["replace", "add", "remove"] as const, "replace");
      const queries = list(a, "items", 10, 300, true) ?? [];
      const pi = intel.projectIntel(p?.id ?? "");
      const picked = queries.map((q) => itemOf(pi, q));
      const current = pi.direction.focusItemIds;
      const ids = picked.map((i) => i.id);
      const next = mode === "replace" ? [...new Set(ids)] : mode === "add" ? [...new Set([...current, ...ids])] : current.filter((id) => !ids.includes(id));
      const names = picked.map((i) => i.title);
      const say = mode === "remove" ? `Stop treating ${join(names)} as what matters most for ${pi.projectName}.` : `Make ${names.join(" and ")} ${mode === "add" ? "also " : ""}what matters most now for ${pi.projectName}.`;
      return confirm(`Matters most for ${pi.projectName}`, say, names, () => {
        intel.setDirection(pi.projectId, { focusItemIds: next });
        return done(`Updated what matters most for ${pi.projectName}.`, ["intel"], "Focus updated");
      });
    },
    set_target_date: (a, ctx) => {
      const p = projectOf(a, ctx);
      const date = a.date === null ? null : text(a, "date", 10, true);
      if (date !== null && !validDate(date)) throw new Refusal("The date must look like 2026-11-30.");
      const pi = intel.projectIntel(p?.id ?? "");
      if (!pi.outcome) throw new Refusal(`${pi.projectName} needs a confirmed finish line before a target date.`);
      return confirm(`Target date for ${pi.projectName}`, date ? `Target ${date} for ${pi.projectName}.` : `Clear the target date for ${pi.projectName}.`, [], () => {
        intel.setSchedule(pi.projectId, { targetDate: date });
        return done(date ? `Target date set to ${date}.` : "Target date cleared.", ["intel"], "Target date saved");
      });
    },
    add_item: (a, ctx) => {
      const p = projectOf(a, ctx);
      const kind = oneOf<ItemKind>(a, "kind", ["requirement", "milestone", "commitment", "blocker", "decision", "exclusion"]);
      const title = text(a, "title", 300, true);
      const dueDate = text(a, "dueDate", 10);
      if (dueDate && !validDate(dueDate)) throw new Refusal("The due date must look like 2026-11-30.");
      const owner = a.owner === undefined ? undefined : oneOf<Owner>(a, "owner", ["me", "client", "third_party", "unknown"]);
      const id = p?.id ?? "", name = p?.name ?? "";
      return confirm(`Add to ${name}`, `Add the ${kind} "${title}" to ${name}${dueDate ? `, due ${dueDate}` : ""}.`, [title], () => {
        intel.addItem(id, { kind, title, ...(dueDate ? { dueDate } : {}), ...(owner ? { owner } : {}) });
        return done(`Added "${title}" to ${name}.`, ["intel"], "Item added");
      });
    },
    update_item: (a, ctx) => {
      const p = projectOf(a, ctx);
      const pi = intel.projectIntel(p?.id ?? "");
      const item = itemOf(pi, text(a, "item", 300, true));
      const fields: { title?: string; status?: "open" | "in_progress" | "done" | "dropped"; dueDate?: string | null; owner?: Owner; lane?: Lane; goal?: string } = {};
      const title = text(a, "title", 300); if (title) fields.title = title;
      if (a.status !== undefined) fields.status = oneOf(a, "status", ["open", "in_progress", "done", "dropped"] as const);
      if (a.dueDate !== undefined) { const d = a.dueDate === null ? null : text(a, "dueDate", 10, true); if (d !== null && !validDate(d)) throw new Refusal("The due date must look like 2026-11-30."); fields.dueDate = d; }
      if (a.owner !== undefined) fields.owner = oneOf<Owner>(a, "owner", ["me", "client", "third_party", "unknown"]);
      if (a.lane !== undefined) fields.lane = oneOf<Lane>(a, "lane", ["finish_line", "extra", "phase2"]);
      const goal = text(a, "goal", 500); if (goal) fields.goal = goal;
      const changes = Object.entries(fields).map(([k, v]) => `${k}: ${v === null ? "none" : String(v)}`);
      if (!changes.length) throw new Refusal("What should change about it?");
      return confirm(`Change "${item.title}"`, `Change "${item.title}": ${changes.join(", ")}.`, changes, () => {
        intel.patchItem(item.id, fields);
        return done(`Updated "${fields.title ?? item.title}".`, ["intel"], "Item updated");
      });
    },
    verify_item: (a, ctx) => {
      const pi = intel.projectIntel(projectOf(a, ctx)?.id ?? "");
      const item = itemOf(pi, text(a, "item", 300, true));
      return confirm("Verify", `Mark "${item.title}" verified: you checked it works.`, [item.title], () => {
        intel.verifyItem(item.id);
        return done(`"${item.title}" is verified.`, ["intel"], "Verified");
      });
    },
    reopen_item: (a, ctx) => {
      const pi = intel.projectIntel(projectOf(a, ctx)?.id ?? "");
      const item = itemOf(pi, text(a, "item", 300, true));
      const note = text(a, "note", 500) ?? null;
      return confirm("Reopen", `Reopen "${item.title}"${note ? `: ${note}` : ""}.`, [item.title, ...(note ? [note] : [])], () => {
        intel.reopenItem(item.id, note);
        return done(`Reopened "${item.title}".`, ["intel"], "Reopened");
      });
    },
    resolve_decision: (a, ctx) => {
      const q = text(a, "decision", 300, true);
      const accept = bool(a, "accept");
      const note = text(a, "note", 500) ?? null;
      const p = projectOf(a, ctx, "project", false);
      const ds = intel.focus().decisions.filter((d) => !p || d.projectId === p.id);
      const r = resolveNamed(q, ds.map((d) => ({ id: d.id, name: d.summary, d })));
      if ("ambiguous" in r) throw new Refusal(`Which decision: ${join(r.candidates.map((c) => sp(c, 80)))}?`, { ambiguous: true });
      if ("none" in r) throw new Refusal("I couldn't find that decision.", { notFound: true });
      const d = r.project.d;
      return confirm(accept ? "Accept decision" : "Reject decision", `${accept ? "Accept" : "Reject"}: ${d.summary} (${d.projectName}).`, [d.summary], () => {
        intel.resolveProposal(d.id, accept, note);
        return done(`${accept ? "Accepted" : "Rejected"}: ${d.summary}.`, ["intel"], accept ? "Accepted" : "Rejected");
      });
    },
    mark_step: (a, ctx) => {
      const p = projectOf(a, ctx);
      const step = oneOf<MarkableStep>(a, "step", ["live", "using", "signed_off"]);
      const reached = bool(a, "reached");
      const label = { live: "live", using: "the client is using it", signed_off: "signed off" }[step];
      const id = p?.id ?? "", name = p?.name ?? "";
      return confirm(`Step for ${name}`, reached ? `Mark ${name} as ${label}.` : `Unmark ${label} for ${name}.`, [], () => {
        intel.setStep(id, step, reached);
        return done(`${name}: ${reached ? "marked" : "unmarked"} ${label}.`, ["intel"], "Step saved");
      });
    },
    mark_shown_to_client: (a, ctx) => {
      const p = projectOf(a, ctx);
      const id = p?.id ?? "", name = p?.name ?? "";
      return confirm(`Shown to the client`, `Record that you showed ${name} to the client today.`, [], () => {
        intel.markDemo(id);
        return done(`Recorded a demo of ${name}.`, ["intel"], "Shown to the client");
      });
    },
    add_finish_line_items: (a, ctx) => {
      const p = projectOf(a, ctx);
      const items = list(a, "items", 30, 300, true) ?? [];
      const acceptance = list(a, "acceptance", 20, 300) ?? [];
      const id = p?.id ?? "", name = p?.name ?? "";
      return confirm(`Finish-line items for ${name}`, `Add ${items.length} finish-line item${items.length === 1 ? "" : "s"} to ${name}${acceptance.length ? ` and ${acceptance.length} acceptance criteria` : ""}.`, items, () => {
        const r = intel.addFinishLineItems(id, items.map((title) => ({ title })), acceptance);
        return done(`Added ${r.added} finish-line item${r.added === 1 ? "" : "s"} to ${name}${r.skipped ? `; ${r.skipped} were already there` : ""}.`, ["intel"], "Finish line updated");
      });
    },
    inbox_action: async (a) => {
      const q = text(a, "item", 300, true);
      const action = oneOf<AttentionAction>(a, "action", ["handled", "tomorrow", "dismiss"]);
      const pf = await deps.portfolio.current();
      const open = pf.inbox.filter((i) => i.status === "open");
      const r = resolveNamed(q, open.map((i) => ({ id: i.id, name: i.title })));
      if ("ambiguous" in r) throw new Refusal(`Which one: ${join(r.candidates.map((c) => sp(c, 80)))}?`, { ambiguous: true });
      if ("none" in r) throw new Refusal("I couldn't find that Inbox item.", { notFound: true });
      const it = r.project;
      const verb = { handled: "Mark handled", tomorrow: "Snooze to tomorrow", dismiss: "Dismiss", undo: "Undo" }[action];
      return confirm("Inbox", `${verb}: ${it.name}.`, [it.name], () => {
        if (!deps.portfolio.attention(it.id, action)) return failure("That Inbox item is gone.", "failed");
        return done(`${verb}: ${it.name}.`, ["portfolio"], "Inbox updated");
      });
    },
    meeting_item_action: (a) => {
      const q = text(a, "item", 300, true);
      const action = oneOf(a, "action", ["done", "dropped", "open", "confirm", "not_yet"] as const);
      const items = deps.meetings.items({ kinds: ["commitment", "suggestion", "pain_point", "decision"], statuses: ["open", "planned", "looks_done", "done", "dropped"] });
      const r = resolveNamed(q, items.map((i) => ({ id: i.id, name: i.text })));
      if ("ambiguous" in r) throw new Refusal(`Which one: ${join(r.candidates.map((c) => sp(c, 80)))}?`, { ambiguous: true });
      if ("none" in r) throw new Refusal("I couldn't find that meeting item.", { notFound: true });
      const it = r.project;
      const verb = { done: "Mark done", dropped: "Drop", open: "Reopen", confirm: "Confirm it's done", not_yet: "Say it's not done yet" }[action];
      return confirm("Meeting item", `${verb}: ${it.name}.`, [it.name], () => {
        deps.meetings.setItemStatus(it.id, action);
        return done(`${verb}: ${it.name}.`, ["meetings", "portfolio"], "Meeting item updated");
      });
    },
    promote_idea: (a) => setStrength(a, "firm"),
    demote_promise: (a) => setStrength(a, "tentative"),
    pin_project: (a, ctx) => {
      const p = projectOf(a, ctx);
      const pinned = bool(a, "pinned");
      const id = p?.id ?? "", name = p?.name ?? "";
      return confirm(pinned ? "Pin project" : "Unpin project", `${pinned ? "Pin" : "Unpin"} ${name}${pinned ? " so it stays in Active" : ""}.`, [], () => {
        if (!deps.portfolio.override(id, { pinned })) return failure("DAVE can't pin that project.", "failed");
        return done(`${pinned ? "Pinned" : "Unpinned"} ${name}.`, ["portfolio"], pinned ? "Pinned" : "Unpinned");
      });
    },
    forget_note: (a) => {
      const q = text(a, "note", 500, true);
      const notes = intel.directionNotes("all", 200);
      const r = resolveNamed(q, notes.map((n) => ({ id: n.id, name: n.text })));
      if ("ambiguous" in r) throw new Refusal(`Which note: ${join(r.candidates.map((c) => sp(c, 80)))}?`, { ambiguous: true });
      if ("none" in r) throw new Refusal("I couldn't find that note.", { notFound: true });
      const n = r.project;
      return confirm("Forget note", `Forget the note: ${n.name}.`, [n.name], () => {
        intel.deleteDirectionNote(n.id);
        return done("Forgot that note.", ["intel"], "Note forgotten");
      });
    },

    // ---- immediate
    remember: (a, ctx) => {
      const t = text(a, "text", 500, true);
      const p = projectOf(a, ctx, "project", false);
      intel.addDirectionNote(p?.id ?? null, t, "voice");
      return done(`Noted${p ? ` for ${p.name}` : ""}: ${t}`, ["intel"], "DAVE will remember");
    },
    attach_document: (a, ctx) => {
      const d = documentOf(text(a, "document", 300, true));
      const p = a.project === null ? null : projectOf(a, ctx);
      const meta = deps.documents.setProject(d.id, p?.id ?? null);
      if (!meta) return failure("DAVE couldn't attach that document.", "failed");
      return done(p ? `Attached ${d.name} to ${p.name}.` : `Detached ${d.name}.`, ["documents"], p ? "Document attached" : "Document detached");
    },
    open_page: (a, ctx) => {
      const page = oneOf(a, "page", ["focus", "queue", "projects", "meetings", "cleanup", "connections", "issues"] as const);
      const p = page === "focus" || page === "projects" ? projectOf(a, ctx, "project", false) : null;
      const section = page === "meetings" && a.section !== undefined ? oneOf(a, "section", ["promises", "asks", "list", "instructions"] as const) : null;
      const link = page === "focus" ? routeLink("focus", { project: p?.id ?? null })
        : page === "projects" ? routeLink("projects", { id: p?.id ?? null })
          : page === "meetings" ? routeLink("meetings", { section: section === "promises" ? null : section })
            : routeLink(page);
      const label = p ? `${page} for ${p.name}` : page;
      return { response: { ok: true, output: json({ done: true, say: sp(`Showing ${label}.`) }), card: card("gray", `Opened ${label}`, undefined, link), ui: { navigate: link } }, status: "done", summary: `Read: opened ${label}` };
    },
    end_session: () => ({ response: { ok: true, output: json({ done: true, say: "Goodbye." }), endSession: true, card: card("gray", "Session ended") }, status: "done", summary: "Read: ended the session" }),
  };

  async function guarded(fn: () => Promise<Result> | Result): Promise<Result> {
    try { return await fn(); }
    catch (e) {
      if (e instanceof Refusal) return failure(e.message, "refused", e.output);
      if (e instanceof IntelError) return failure(e.message, e.code === "not-found" || e.code === "invalid" ? "refused" : "failed");
      const status = (e as { statusCode?: unknown } | null)?.statusCode;
      if (typeof status === "number" && status < 500 && e instanceof Error) return failure(e.message, "refused");
      return failure("Something went wrong inside DAVE. Nothing was changed.", "failed");
    }
  }
  async function runStored(fn: () => Promise<Done> | Done): Promise<Done> {
    const r = await guarded(fn);
    if ("confirm" in r) return failure("Something went wrong inside DAVE.", "failed");
    return r.status === "done" ? { ...r, status: "confirmed" } : r;
  }

  async function execute(ctx: Ctx, req: ToolCallRequest): Promise<ToolCallResponse> {
    const prior = deps.store.getAction(ctx.sessionId, req.callId);
    if (prior) return prior;
    let result: Done;
    const handler = handlers[req.name];
    if (!handler || !VOICE_TOOL_NAMES.has(req.name)) result = failure("DAVE has no tool by that name.", "refused");
    else if (WRITE_NAMES.has(req.name) && req.args.confirmToken !== undefined) {
      const token = req.args.confirmToken;
      const yes = req.args.userConfirmed;
      if (typeof token !== "string" || typeof yes !== "boolean") result = failure("Send the confirmToken with userConfirmed true or false.", "refused");
      else {
        const taken = deps.confirms.take(ctx.sessionId, token, req.name);
        if (!taken.ok) result = failure(taken.reason === "expired" ? "That confirmation expired. Prepare the change again and ask once more." : "That confirmation is not valid any more. Prepare the change again.", "refused");
        else if (!yes) result = { response: { ok: true, output: json({ cancelled: true, say: "Okay, nothing changed." }), card: card("gray", "Cancelled", taken.card.title) }, status: "cancelled", summary: `Cancelled: ${taken.card.title}` };
        else result = await runStored(taken.action.run);
      }
    } else {
      const r = await guarded(() => handler(req.args, ctx));
      if ("confirm" in r && ctx.autoApprove) {
        const ran = await runStored(r.confirm.run);
        if (ran.status !== "confirmed") result = ran;
        else {
          const say = sp(ran.summary);
          result = {
            response: { ...ran.response, output: json({ done: true, autoApproved: true, say }), card: card("green", r.confirm.title, `Approved for this session. ${say}`) },
            status: "confirmed", summary: `Approved for this session: ${ran.summary}`,
          };
        }
      } else if ("confirm" in r) {
        const c = deps.confirms.prepare(ctx.sessionId, req.name, { run: r.confirm.run }, r.confirm.say, r.confirm.title, r.confirm.details);
        result = { response: { ok: true, output: json({ needsConfirmation: true, confirmToken: c.token, say: c.say }), confirm: c, card: card("amber", c.title, c.say) }, status: "needs_confirmation", summary: `Asked: ${c.title}` };
      } else result = r;
    }
    deps.store.putAction(ctx.sessionId, req.callId, req.name, result.status, result.summary, result.response);
    return result.response;
  }

  /** The amber card's Confirm / Not that buttons. */
  async function click(sessionId: string, req: ConfirmClickRequest): Promise<ToolCallResponse> {
    const taken = deps.confirms.take(sessionId, req.token);
    let result: Done;
    if (!taken.ok) result = failure(taken.reason === "expired" ? "That confirmation expired." : "That confirmation is not valid any more.", "refused");
    else if (!req.accept) result = { response: { ok: true, output: json({ cancelled: true, say: "The user clicked Not that. Nothing changed." }), card: card("gray", "Cancelled", taken.card.title) }, status: "cancelled", summary: `Cancelled: ${taken.card.title}` };
    else result = await runStored(taken.action.run);
    deps.store.putAction(sessionId, `click:${req.token.slice(0, 64)}`, taken.ok ? taken.toolName : "confirm", result.status, result.summary, result.response);
    return result.response;
  }

  return { execute, click };
}
export type ToolExecutor = ReturnType<typeof createToolExecutor>;
