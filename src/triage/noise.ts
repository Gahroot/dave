import type { IntelItem, Proposal } from "../intel/types.ts";
import type { MeetingItem } from "../meetings/types.ts";
import { isTentative } from "../meetings/obligation.ts";
import { linkedIntelItems, meetingSourceIds } from "./links.ts";
import {
  OLD_ASK_DAYS, STALE_PROMISE_DAYS, TRIAGE_BUCKETS,
  type TriageBucket, type TriageEntry, type TriageFilter, type TriageKind,
} from "./types.ts";

/**
 * Clean up classifier: which meeting promises, client asks and drafted decisions look like noise.
 * Pure and deterministic; the clock is injected. Never reads or returns a verbatim quote.
 */

const DAY_MS = 86_400_000;

export type NoiseInput = {
  meetingItems: readonly MeetingItem[];
  proposals: readonly Proposal[];
  intelItems: readonly IntelItem[];
  now: Date;
  projectName?: (projectId: string) => string | null;
};

const dayStart = (iso: string): number => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
const today = (now: Date): string => now.toISOString().slice(0, 10);

/** "12 Sep" in UTC. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function shortDay(iso: string): string {
  const d = new Date(dayStart(iso));
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ""}`;
}

/** "today", "1 day ago", "5 weeks ago", "3 months ago". */
export function ago(days: number): string {
  if (days <= 0) return "today";
  if (days < 14) return days === 1 ? "1 day ago" : `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

/** Whole calendar days from `iso` to `now`; null when unparseable. */
export function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const start = dayStart(iso);
  return Number.isFinite(start) ? Math.floor((dayStart(now.toISOString()) - start) / DAY_MS) : null;
}

const meetingWhen = (m: MeetingItem): string | null => m.meetingAt || m.createdAt || null;

function bucketOf(m: MeetingItem, now: Date): { bucket: TriageBucket; kind: TriageKind } | null {
  // Ideas mentioned (tentative) sit only in the ideas bucket, never with promises or asks.
  if (isTentative(m)) {
    if (m.status !== "open") return null;
    return { bucket: "ideas", kind: m.kind === "commitment" ? "promise" : m.kind === "decision" ? "decision" : "ask" };
  }
  const kind: TriageKind | null = m.kind === "commitment" ? "promise" : m.kind === "suggestion" || m.kind === "pain_point" ? "ask" : null;
  if (!kind) return null;
  if (m.status === "looks_done") return { bucket: "looks_done", kind };
  if (m.status !== "open") return null;
  const age = daysSince(meetingWhen(m), now) ?? 0;
  if (kind === "promise") {
    if (m.dueDate && m.dueDate < today(now)) return { bucket: "overdue_promises", kind };
    return age >= STALE_PROMISE_DAYS ? { bucket: "stale_promises", kind } : null;
  }
  return age >= OLD_ASK_DAYS ? { bucket: "old_asks", kind } : null;
}

function meetingReasons(m: MeetingItem, bucket: TriageBucket, confirmed: boolean, now: Date): string[] {
  const reasons: string[] = [];
  if (bucket === "ideas") reasons.push("Said as an idea, not a promise");
  if (bucket === "looks_done") reasons.push(m.suggestedStatus === "dropped" ? "DAVE thinks this was dropped" : "DAVE thinks this is done");
  if (m.dueDate && m.dueDate < today(now)) {
    const late = daysSince(m.dueDate, now) ?? 1;
    reasons.push(`Due ${shortDay(m.dueDate)}, ${late === 1 ? "1 day" : `${late} days`} ago`);
  }
  else if (m.kind === "commitment" && bucket !== "ideas") reasons.push(m.dueDate ? `Due ${shortDay(m.dueDate)}` : "No due date");
  const age = daysSince(meetingWhen(m), now);
  if (age !== null) reasons.push(`From a meeting ${ago(age)}`);
  if (!confirmed) reasons.push("Never confirmed");
  return reasons;
}

const titleOfLabel = (label: string): string => label.replace(/, \d{4}-\d{2}-\d{2}$/, "");

function decisionEntry(p: Proposal, byId: ReadonlyMap<string, IntelItem>, now: Date): TriageEntry {
  const item = p.itemId ? byId.get(p.itemId) : undefined;
  const confirmed = !!item && (item.basis === "confirmed" || item.locked);
  const meetingProv = p.provenance.filter((x) => x.sourceKind === "meeting").sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  const latest = meetingProv[0];
  const reasons: string[] = [];
  const age = daysSince(latest?.observedAt ?? null, now);
  if (age !== null) reasons.push(`Drafted from a meeting ${ago(age)}`);
  const waited = daysSince(p.createdAt, now);
  if (waited !== null && waited > 0) reasons.push(`Waiting on you for ${ago(waited).replace(/ ago$/, "")}`);
  return {
    key: `p:${p.id}`, kind: "decision", bucket: "meeting_decisions", title: p.summary,
    projectId: p.projectId, projectName: p.projectName || null, dueDate: null,
    meetingAt: latest?.observedAt ?? null, meetingTitle: latest ? titleOfLabel(latest.label) : null,
    recordingId: latest?.link ? /[?&]rec=([A-Za-z0-9_-]{1,128})/.exec(latest.link)?.[1] ?? null : null,
    reasons, confirmed,
  };
}

const BUCKET_RANK = new Map<TriageBucket, number>(TRIAGE_BUCKETS.map((b, i) => [b, i]));

/** Bucket order, then project name, due date (undated last) and key. */
export function compareEntries(a: TriageEntry, b: TriageEntry): number {
  return (BUCKET_RANK.get(a.bucket) ?? 0) - (BUCKET_RANK.get(b.bucket) ?? 0)
    || (a.projectName ?? "\uffff").localeCompare(b.projectName ?? "\uffff")
    || (a.dueDate ?? "\uffff").localeCompare(b.dueDate ?? "\uffff")
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/** Every entry that looks like noise, confirmed ones included (filterEntries hides those by default). */
export function classifyNoise(input: NoiseInput): TriageEntry[] {
  const { now } = input;
  const entries: TriageEntry[] = [];
  const listed = new Set<string>();
  for (const m of input.meetingItems) {
    const placed = bucketOf(m, now);
    if (!placed) continue;
    const linked = linkedIntelItems(input.intelItems, m.id);
    const confirmed = m.statusSource === "user" || m.edited || linked.some((i) => i.basis === "confirmed" || i.locked);
    listed.add(m.id);
    entries.push({
      key: `m:${m.id}`, kind: placed.kind, bucket: placed.bucket, title: m.text,
      projectId: m.projectId, projectName: m.projectName ?? (m.projectId ? input.projectName?.(m.projectId) ?? null : null),
      dueDate: m.dueDate, meetingAt: meetingWhen(m), meetingTitle: m.meetingTitle || null, recordingId: m.recordingId,
      reasons: meetingReasons(m, placed.bucket, confirmed, now), confirmed,
    });
  }
  const byId = new Map(input.intelItems.map((i) => [i.id, i]));
  for (const p of input.proposals) {
    if (p.status !== "pending") continue;
    const sources = meetingSourceIds(p.provenance);
    if (!sources.length) continue;
    const item = p.itemId ? byId.get(p.itemId) : undefined;
    const covered = sources.some((id) => listed.has(id)) || (!!item && meetingSourceIds(item.provenance).some((id) => listed.has(id)));
    if (!covered) entries.push(decisionEntry(p, byId, now));
  }
  return entries.sort(compareEntries);
}

/** Applies a filter. Confirmed entries are hidden unless `includeConfirmed` is set. */
export function filterEntries(entries: readonly TriageEntry[], filter: TriageFilter, now: Date): TriageEntry[] {
  const text = filter.text?.trim().toLowerCase() ?? "";
  const keys = filter.keys ? new Set(filter.keys) : null;
  const day = today(now);
  return entries.filter((e) => {
    if (filter.buckets?.length && !filter.buckets.includes(e.bucket)) return false;
    if (filter.kinds?.length && !filter.kinds.includes(e.kind)) return false;
    if (filter.projectId !== undefined && e.projectId !== filter.projectId) return false;
    if (filter.recordingId !== undefined && e.recordingId !== filter.recordingId) return false;
    if (!filter.includeConfirmed && e.confirmed) return false;
    if (filter.overdueOnly && !(e.dueDate && e.dueDate < day)) return false;
    if (filter.olderThanDays !== undefined && (daysSince(e.meetingAt, now) ?? -1) < filter.olderThanDays) return false;
    if (keys && !keys.has(e.key)) return false;
    if (text && ![e.title, e.projectName ?? "", e.meetingTitle ?? ""].some((s) => s.toLowerCase().includes(text))) return false;
    return true;
  });
}

/** Per-bucket counts, every bucket present. */
export function countByBucket(entries: readonly TriageEntry[]): Record<TriageBucket, number> {
  const counts = Object.fromEntries(TRIAGE_BUCKETS.map((b) => [b, 0])) as Record<TriageBucket, number>;
  for (const e of entries) counts[e.bucket] += 1;
  return counts;
}
