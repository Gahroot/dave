/**
 * Pure helpers for the phone's Meetings and Connections screens. No React
 * Native imports: mirrors the decisions made inline in the web components
 * (src/ui/sections/Meeting*.tsx, ProjectMeetings.tsx, FathomConnection.tsx).
 */
import type { Disclosure, ItemKind, MeetingDetail, MeetingItem, MeetingRow, MeetingsState, ProjectMeetingsOverview, PromiseStateName } from "../../../../src/meetings/types.ts";
import { promiseGroup } from "../../../../src/ui/meetings-model.ts";
import { CONNECTION, ITEM_KIND, ITEM_STATUS, PROMISE_GROUP, type StatusSpec } from "../../../../src/ui/status.ts";

export type MeetingSection = "promises" | "asks" | "list" | "instructions";
export const MEETING_SECTIONS: readonly { id: MeetingSection; label: string }[] = [
  { id: "promises", label: "Your promises" },
  { id: "asks", label: "Client asks" },
  { id: "list", label: "Meetings" },
  { id: "instructions", label: "Reading instructions" },
];

export function parseSection(value: string | string[] | undefined): MeetingSection {
  const one = Array.isArray(value) ? value[0] : value;
  return MEETING_SECTIONS.find((s) => s.id === one)?.id ?? "promises";
}

/** Fathom recording ids are digits only. */
export function recordingId(value: string | string[] | undefined): string | null {
  const one = Array.isArray(value) ? value[0] : value;
  return one && /^\d{1,20}$/.test(one) ? one : null;
}

export function day(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function meetingWhen(iso: string, weekday = false): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleString([], { ...(weekday ? { weekday: "short" } : {}), month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function durationMinutes(m: Pick<MeetingRow, "startedAt" | "endedAt">): number | null {
  if (!m.startedAt || !m.endedAt) return null;
  const minutes = Math.round((Date.parse(m.endedAt) - Date.parse(m.startedAt)) / 60_000);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}

/** The state that most needs the owner: overdue/due soon beats the stored status, which beats the kind. */
export function leadSpec(item: MeetingItem, now: Date): StatusSpec {
  if (item.status === "open" && item.kind === "commitment") {
    const group = promiseGroup(item, now);
    if (group === "overdue" || group === "due_soon") return PROMISE_GROUP[group];
  }
  return item.status === "open" ? ITEM_KIND[item.kind] : ITEM_STATUS[item.status];
}

export function dueText(item: Pick<MeetingItem, "dueDate" | "duePhrase">): string {
  if (item.dueDate) return `Due ${day(item.dueDate)}${item.duePhrase ? ` (“${item.duePhrase}”)` : ""}`;
  return item.duePhrase ? `“${item.duePhrase}”` : "";
}

export type ItemAction = "done" | "dropped" | "open" | "confirm" | "not_yet";
export type ActionChoice = { action: ItemAction; label: string; variant: "primary" | "secondary" | "subtle" };

/** The owner's options for one item. Nothing closes without one of these taps. */
export function itemChoices(item: MeetingItem): { draft: boolean; actions: ActionChoice[] } {
  if (item.kind === "decision") return { draft: false, actions: [] };
  if (item.status === "looks_done") return { draft: false, actions: [
    { action: "confirm", label: item.suggestedStatus === "dropped" ? "Yes, it was dropped" : "Yes, it's done", variant: "primary" },
    { action: "not_yet", label: "Not yet", variant: "secondary" },
  ] };
  if (item.status === "done" || item.status === "dropped") return { draft: false, actions: [{ action: "open", label: "Reopen", variant: "secondary" }] };
  if (item.status !== "open") return { draft: false, actions: [] };
  const draft = item.kind === "pain_point" && !!item.feature && !!item.projectId;
  return { draft, actions: [
    { action: "done", label: item.kind === "commitment" ? "Mark done" : "Mark handled", variant: draft ? "secondary" : "primary" },
    { action: "dropped", label: item.kind === "commitment" ? "Drop" : "Dismiss", variant: "subtle" },
  ] };
}

/** The status note shows when it explains a suggestion, a plan, or a non-model change. */
export function showStatusNote(item: MeetingItem): boolean {
  return !!item.statusNote && (item.status === "looks_done" || item.status === "planned" || item.statusSource !== "model");
}

export function meetingCountsText(m: MeetingRow): string {
  const asks = m.counts.pain_point + m.counts.suggestion;
  return `${m.counts.commitment} promise${m.counts.commitment === 1 ? "" : "s"}, ${asks} client ask${asks === 1 ? "" : "s"}`;
}

export const KIND_ORDER: readonly ItemKind[] = ["commitment", "pain_point", "suggestion", "decision"];
export function itemsByKind(items: readonly MeetingItem[]): { kind: ItemKind; items: MeetingItem[] }[] {
  return KIND_ORDER.map((kind) => ({ kind, items: items.filter((i) => i.kind === kind) })).filter((g) => g.items.length > 0);
}

export function externalDomains(detail: Pick<MeetingDetail, "attendees">): string[] {
  const out: string[] = [];
  for (const a of detail.attendees) if (a.external && a.domain && !out.includes(a.domain)) out.push(a.domain);
  return out;
}

export function attendeeText(detail: Pick<MeetingDetail, "attendees">): string {
  return detail.attendees.map((a) => a.name ?? a.email ?? "Unknown").join(", ") || "No attendee data";
}

export function canAnalyze(status: MeetingRow["status"]): boolean {
  return status === "imported" || status === "analyzed" || status === "failed";
}

/** Polling runs only while a sync or analysis is running. */
export function meetingsActive(state: MeetingsState | null): boolean {
  return !!state && (state.sync.running || !!state.analysis.running || state.analysis.queued.length > 0);
}

export function isAnalyzing(state: MeetingsState | null, rec: string): boolean {
  return !!state && (state.analysis.running === rec || state.analysis.queued.includes(rec));
}

export function fathomConnected(state: MeetingsState | null): boolean {
  return !!state?.key.saved && !!state.settings.connectedAt;
}

export function analysisMarkText(state: MeetingsState): string {
  const a = state.analysis;
  if (a.running) return `Analyzing${a.queued.length ? `, ${a.queued.length} waiting` : ""}`;
  return a.on ? "Analysis on" : a.consentOutdated ? "Analysis paused" : "Analysis off";
}

/** Consent bodies: per-meeting consent only covers the first disclosure section, like the web. */
export function consentDisclosure(d: Disclosure): Disclosure {
  return { ...d, sections: d.sections.slice(0, 1) };
}

/**
 * Body for an analyze/reanalyze call. Consent is sent only when the owner
 * agreed to the disclosure version shown; automatic analysis sends none.
 */
export function consentBody(consented: boolean, state: MeetingsState | null): { consentVersion?: string } {
  return consented && state ? { consentVersion: state.analysis.disclosure.version } : {};
}

export function fathomMark(state: MeetingsState | null): StatusSpec {
  if (!state) return CONNECTION.pending;
  if (state.key.storageError || state.key.state === "invalid") return CONNECTION["invalid-key"];
  if (!state.key.saved || !state.settings.connectedAt) return CONNECTION.disconnected;
  if (state.sync.lastError) return { ...CONNECTION.error, label: "Connected, last check failed" };
  return state.settings.paused ? CONNECTION.paused : CONNECTION.connected;
}

export function analysisStatusText(a: MeetingsState["analysis"]): string {
  const base = a.on ? "On: new meetings are analyzed automatically."
    : a.consentOutdated ? "Paused: what DAVE sends has changed. Review it to turn analysis back on."
    : "Off: meetings are imported but not analyzed. You can still analyze one meeting at a time.";
  return `${base}${a.on && !a.openAIConnected ? " OpenAI is not connected, so nothing is sent. Connect or restore it above." : ""}`;
}

export function syncProblemText(sync: MeetingsState["sync"], now: Date): string | null {
  if (!sync.lastError) return null;
  const until = sync.backoffUntil ? Date.parse(sync.backoffUntil) : NaN;
  const retry = !Number.isNaN(until) && until > now.getTime()
    ? ` DAVE tries again automatically after ${new Date(until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : "";
  return `Last problem: ${sync.lastError}.${retry}`;
}

export const splitList = (value: string): string[] => value.split(",").map((v) => v.trim()).filter(Boolean);

// ── Project "From meetings" ────────────────────────────────────────────────

const OVERLOOKED: readonly PromiseStateName[] = ["overdue", "not_followed_up"];
export const STATE_NOTE: Record<PromiseStateName, string> = { overdue: "Overdue", due_soon: "Due soon", not_followed_up: "No work since the call", open: "" };
export const EVIDENCE_LABEL = { commit: "Commit", run: "Accepted agent run", milestone: "Finished milestone", task: "Done task" } as const;

export function projectGroups(data: ProjectMeetingsOverview) {
  const promises = data.items.filter((i) => i.kind === "commitment");
  const state = (i: MeetingItem): PromiseStateName => data.promiseStates[i.id] ?? "open";
  return {
    state,
    overlooked: promises.filter((i) => i.status === "open" && OVERLOOKED.includes(state(i))),
    open: promises.filter((i) => (i.status === "open" && !OVERLOOKED.includes(state(i))) || i.status === "looks_done"),
    done: promises.filter((i) => i.status === "done"),
    asks: data.items.filter((i) => (i.kind === "pain_point" || i.kind === "suggestion") && ["open", "planned", "looks_done"].includes(i.status)),
  };
}

/** Validates the phone's edit form before sending; mirrors the server's rules. */
export function editProblem(text: string, dueDate: string): string | null {
  const t = text.trim();
  if (!t || t.length > 600) return "Text must be 1 to 600 characters";
  if (dueDate.trim() && (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate.trim()) || Number.isNaN(Date.parse(`${dueDate.trim()}T00:00:00Z`)))) return "Due date must be YYYY-MM-DD";
  return null;
}
