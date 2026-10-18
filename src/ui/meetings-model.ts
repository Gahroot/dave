import type { MeetingItem, MeetingRow, MeetingsState, SyncRun } from "../meetings/types.ts";

/** Buckets for the promise list. Uses the browser's local calendar day, like the rest of the UI. */
export type PromiseGroup = "overdue" | "due_soon" | "open" | "looks_done";
export const PROMISE_GROUPS: readonly { id: PromiseGroup; label: string }[] = [
  { id: "overdue", label: "Overdue" },
  { id: "due_soon", label: "Due soon" },
  { id: "open", label: "Open" },
  { id: "looks_done", label: "Looks done?" },
];

const localDay = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export function promiseGroup(item: Pick<MeetingItem, "status" | "dueDate">, now: Date): PromiseGroup {
  if (item.status === "looks_done") return "looks_done";
  if (item.dueDate) {
    const today = localDay(now);
    if (item.dueDate < today) return "overdue";
    const soon = new Date(now); soon.setDate(soon.getDate() + 2);
    if (item.dueDate <= localDay(soon)) return "due_soon";
  }
  return "open";
}

/** Groups promises in display order; within a group, earliest due date first, then newest meeting. */
export function groupPromises(items: readonly MeetingItem[], now: Date): { id: PromiseGroup; label: string; items: MeetingItem[] }[] {
  const order = (a: MeetingItem, b: MeetingItem): number =>
    (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || b.meetingAt.localeCompare(a.meetingAt) || a.id.localeCompare(b.id);
  return PROMISE_GROUPS.map(group => ({ ...group, items: items.filter(i => promiseGroup(i, now) === group.id).sort(order) }))
    .filter(group => group.items.length > 0);
}

export const MEETING_STATUS_LABELS: Record<MeetingRow["status"], string> = {
  waiting: "Waiting for transcript",
  unavailable: "Transcript unavailable",
  skipped: "Skipped",
  imported: "Imported, not analyzed",
  analyzed: "Analyzed",
  failed: "Analysis failed",
  forgotten: "Forgotten",
};

export const ITEM_KIND_LABELS: Record<MeetingItem["kind"], string> = {
  commitment: "Your promise",
  suggestion: "Client suggestion",
  pain_point: "Client pain point",
  decision: "Decision",
};
/** Kind labels for tentative items (ideas), which must never read as promises or agreed decisions. */
export const IDEA_KIND_LABELS: Record<MeetingItem["kind"], string> = {
  commitment: "Something you might do",
  suggestion: "Client suggestion",
  pain_point: "Client pain point",
  decision: "Option discussed",
};

export const ITEM_STATUS_LABELS: Record<MeetingItem["status"], string> = {
  open: "Open",
  planned: "Agent run planned",
  looks_done: "Looks done?",
  done: "Done",
  dropped: "Dropped",
};

/** Selective meetings: the heading for maybes and brainstormed ideas. They are kept, but never count as promises. */
export const IDEAS_LABEL = "Ideas mentioned (not promises)";

/** Firm items (promises, asks, agreed decisions) and ideas, each keeping its order. */
export function splitByStrength<T extends Pick<MeetingItem, "strength">>(items: readonly T[]): { firm: T[]; ideas: T[] } {
  return { firm: items.filter(i => i.strength !== "tentative"), ideas: items.filter(i => i.strength === "tentative") };
}

/** Only firm items: ideas never appear in promise or ask lists, or in counts. */
export const firmOnly = <T extends Pick<MeetingItem, "strength">>(items: readonly T[]): T[] => splitByStrength(items).firm;

/** "Oct 21". A date-only due date ("2026-10-21") is a local calendar day; Date.parse would read it as UTC midnight
 * and show the day before anywhere west of UTC. Full timestamps are shown in local time. */
export function shortDay(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(Date.parse(value));
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** "1:35" or "1:02:03": where in the recording an item was said. */
export function timestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

/** One plain sentence for the Fathom card's state. */
export function connectionSummary(state: MeetingsState): string {
  if (state.key.storageError) return "The macOS Keychain is not available, so DAVE cannot read your Fathom key.";
  if (!state.key.saved) return "Not connected.";
  if (state.key.state === "invalid") return "Fathom rejected the saved key.";
  if (!state.settings.connectedAt) return "Key saved but not confirmed yet.";
  if (!state.settings.fathomEmail) return "Connected. Enter your Fathom email to start importing.";
  if (state.settings.paused) return "Connected. Automatic import is paused.";
  if (state.sync.running) return "Checking Fathom now…";
  return "Connected. DAVE checks Fathom every 5 minutes.";
}

export function runSummary(run: SyncRun): string {
  const s = run.stats;
  const parts = [
    s.added ? `${s.added} new` : "",
    s.transcripts ? `${s.transcripts} transcript${s.transcripts === 1 ? "" : "s"}` : "",
    s.skipped ? `${s.skipped} skipped` : "",
    s.unavailable ? `${s.unavailable} unavailable` : "",
  ].filter(Boolean);
  const outcome = run.outcome === "ok" ? "Finished" : run.outcome === "partial" ? "Partly finished" : run.outcome === "skipped" ? "Skipped" : "Failed";
  return `${outcome}${parts.length ? `: ${parts.join(", ")}` : run.outcome === "ok" ? ": nothing new" : ""}${run.error ? `. ${run.error}` : ""}`;
}
