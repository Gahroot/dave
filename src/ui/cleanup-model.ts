import { TRIAGE_BUCKETS, type TriageBatch, type TriageBucket, type TriageEntry, type TriageResult } from "../triage/types.ts";

/** Pure helpers for the Clean up page: grouping, selection and plain-word sentences. */

export type BucketGroup = { bucket: TriageBucket; entries: TriageEntry[] };
export type SelectState = "none" | "some" | "all";

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const items = (n: number): string => plural(n, "item", "items");

/** Non-empty buckets in TRIAGE_BUCKETS order; entries keep their incoming order. */
export function groupByBucket(entries: readonly TriageEntry[]): BucketGroup[] {
  return TRIAGE_BUCKETS.map(bucket => ({ bucket, entries: entries.filter(e => e.bucket === bucket) })).filter(g => g.entries.length > 0);
}

/** Every unconfirmed entry (only in `bucket` when given). Confirmed entries are never preselected. */
export function defaultSelection(entries: readonly TriageEntry[], bucket: TriageBucket | null = null): Set<string> {
  return new Set(entries.filter(e => !e.confirmed && (bucket === null || e.bucket === bucket)).map(e => e.key));
}

export function toggleOne(selected: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selected);
  if (next.has(key)) next.delete(key); else next.add(key);
  return next;
}

export function bucketState(selected: ReadonlySet<string>, entries: readonly TriageEntry[]): SelectState {
  const n = entries.filter(e => selected.has(e.key)).length;
  return n === 0 ? "none" : n === entries.length ? "all" : "some";
}

/** All selected → none; otherwise select every entry in the bucket (including confirmed: the click is explicit). */
export function toggleBucket(selected: ReadonlySet<string>, entries: readonly TriageEntry[]): Set<string> {
  const next = new Set(selected);
  if (bucketState(selected, entries) === "all") for (const e of entries) next.delete(e.key);
  else for (const e of entries) next.add(e.key);
  return next;
}

/** Drop keys that are no longer listed. */
export function pruneSelection(selected: ReadonlySet<string>, entries: readonly TriageEntry[]): Set<string> {
  const keys = new Set(entries.map(e => e.key));
  return new Set([...selected].filter(k => keys.has(k)));
}

export function selectedEntries(selected: ReadonlySet<string>, entries: readonly TriageEntry[]): TriageEntry[] {
  return entries.filter(e => selected.has(e.key));
}

/** Mark done applies only to promises and "looks done" entries. */
export function canMarkDone(selected: readonly TriageEntry[]): boolean {
  return selected.length > 0 && selected.every(e => e.kind === "promise" || e.bucket === "looks_done");
}

const BUCKET_PHRASE: Record<TriageBucket, [string, string]> = {
  overdue_promises: ["overdue promise nobody confirmed", "overdue promises nobody confirmed"],
  stale_promises: ["old promise with no date", "old promises with no date"],
  looks_done: ["item that looks done", "items that look done"],
  old_asks: ["old client ask", "old client asks"],
  meeting_decisions: ["drafted decision from meetings", "drafted decisions from meetings"],
  ideas: ["idea that never became a promise", "ideas that never became promises"],
};

const list = (parts: string[]): string => parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

/** "DAVE found 73 items that look like noise: 41 overdue promises nobody confirmed, … and 2 old client asks." */
export function summarySentence(counts: Readonly<Record<TriageBucket, number>>, total: number): string {
  if (total === 0) return "Nothing looks like noise right now.";
  const parts = TRIAGE_BUCKETS.filter(b => counts[b] > 0).map(b => plural(counts[b], ...BUCKET_PHRASE[b]));
  return `DAVE found ${plural(total, "item that looks", "items that look")} like noise: ${list(parts)}.`;
}

/** "Cleared 41 items. 2 were left alone (already gone). Kept 1 linked record on purpose." */
export function resultText(result: TriageResult, action: "clear" | "done"): string {
  const parts: string[] = [];
  parts.push(result.changed === 0 ? "Nothing was changed." : `${action === "done" ? "Marked" : "Cleared"} ${items(result.changed)}${action === "done" ? " done" : ""}.`);
  if (result.skipped.length) {
    const reasons = [...new Set(result.skipped.map(s => s.reason))].sort();
    parts.push(`${plural(result.skipped.length, "item was", "items were")} left alone (${reasons.join("; ")}).`);
  }
  if (result.kept.length) parts.push(`Kept ${plural(result.kept.length, "linked record", "linked records")} on purpose, such as a plan item you locked.`);
  return parts.join(" ");
}

export function undoText(restored: number, skipped: number): string {
  const head = restored === 0 ? "Nothing needed restoring." : `Restored ${items(restored)}.`;
  return skipped ? `${head} ${plural(skipped, "item was", "items were")} left as is because ${skipped === 1 ? "it" : "they"} changed since.` : head;
}

/** "Cleared 41 items · 18 Oct, 14:05 · from voice" (clock injected via `timeZone`, for determinism in tests). */
export function batchLine(batch: TriageBatch, timeZone?: string): string {
  const when = new Date(batch.createdAt);
  const date = Number.isNaN(when.getTime()) ? "unknown time" : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(when);
  return `${batch.summary.replace(/\.$/, "")} · ${date}${batch.source === "voice" ? " · from voice" : ""}`;
}

/** Sorted, unique projects present in the entries, for the project filter. */
export function projectOptions(entries: readonly TriageEntry[]): { value: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const e of entries) if (e.projectId && !seen.has(e.projectId)) seen.set(e.projectId, e.projectName ?? e.projectId);
  return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
}
