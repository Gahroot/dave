import { ATTENTION, type AgentOverview, type AgentRun } from "../agents/types.ts";
import type { InboxItem } from "../shared/types.ts";
import type { QueueEntry } from "../model/delivery-queue.ts";
import type { InboxFilter } from "./navigation.ts";

export type DeliveryQueueData = { limit: number; entries: QueueEntry[] };
/** Items that are ready for the owner to act on, rather than a decision to make. */
const READY_KINDS: ReadonlySet<InboxItem["kind"]> = new Set(["inspection", "meeting-promise", "client-idea"]);
export const inboxCategory = (kind: InboxItem["kind"]): Exclude<InboxFilter, "all"> => READY_KINDS.has(kind) ? "ready" : "decision";
/** What produced an Inbox item, in plain words. */
export function inboxKindLabel(kind: InboxItem["kind"]): string {
  if (kind === "inspection") return "Inspection suggestion";
  if (kind === "meeting-promise") return "Promise you made in a meeting";
  if (kind === "client-idea") return "Client idea from a meeting";
  return "Human request inferred from task text";
}
export type InboxRow = {
  key: string; source: "agent" | "delivery" | "request"; id: string;
  project: string; title: string; reason: string; timestamp: string | null;
  category: Exclude<InboxFilter, "all">;
} & ({ source: "agent"; value: AgentRun } | { source: "delivery"; value: QueueEntry } | { source: "request"; value: InboxItem });
export function normalizeInbox(requests: InboxItem[], agents: AgentOverview | null, delivery: DeliveryQueueData | null): InboxRow[] {
  const rows: InboxRow[] = [
    ...(agents?.runs ?? []).filter(run => ATTENTION.includes(run.status)).map((run): InboxRow => ({ key: `agent:${run.id}`, source: "agent", id: run.id, project: run.projectName, title: run.title, reason: run.status === "waiting" ? "Permission requested" : run.reason || "Review agent evidence", timestamp: run.updatedAt, category: "decision", value: run })),
    ...(delivery?.entries ?? []).map((entry): InboxRow => ({ key: `delivery:${entry.projectId}`, source: "delivery", id: entry.projectId, project: entry.projectName, title: entry.step.headline, reason: entry.step.why, timestamp: entry.startedAt, category: entry.state === "paused" || entry.step.kind === "waiting" || entry.step.kind === "unblock" ? "waiting" : ["send", "setup", "scope", "plan"].includes(entry.step.kind) ? "ready" : "decision", value: entry })),
    ...requests.map((item): InboxRow => ({ key: `request:${item.id}`, source: "request", id: item.id, project: item.projectName ?? "Project unavailable", title: item.detail || item.title, reason: item.projectName && item.title.startsWith(`${item.projectName}: `) ? item.title.slice(item.projectName.length + 2) : item.title, timestamp: item.lastObservedAt, category: inboxCategory(item.kind), value: item })),
  ];
  const seen = new Set<string>();
  return rows.filter(row => { if (seen.has(row.key)) return false; seen.add(row.key); return true; });
}
export type InboxCategory = Exclude<InboxFilter, "all">;
export const INBOX_CATEGORIES: readonly InboxCategory[] = ["decision", "ready", "waiting"];
/** Per-category counts for filter tabs. */
export function inboxCounts(rows: readonly InboxRow[]): Record<InboxFilter, number> {
  const counts: Record<InboxFilter, number> = { all: rows.length, decision: 0, ready: 0, waiting: 0 };
  for (const row of rows) counts[row.category] += 1;
  return counts;
}
/**
 * The sentence a row asks of you. Rows that ask the same thing share one header so the
 * ask is read once, while every row stays visible with its own project.
 */
export function inboxAsk(row: InboxRow): string {
  if (row.source === "agent") return row.value.status === "waiting" ? "Agent needs permission" : row.value.status === "failed" ? "Agent run failed" : row.value.status === "interrupted" ? "Agent run disconnected" : "Review agent work";
  // Requests: the detail is the specific ask; the title tail ("an agent is waiting on you") is boilerplate.
  return row.title;
}
export type InboxCluster = { ask: string; rows: InboxRow[] };
export type InboxSection = { category: InboxCategory; count: number; clusters: InboxCluster[] };
/**
 * Groups visible rows by category (in display order), then by identical ask. Order inside a
 * category follows the incoming order, so paging and focus restoration stay stable. A cluster
 * of one keeps its ask on the row itself.
 */
export function groupInbox(rows: readonly InboxRow[]): InboxSection[] {
  return INBOX_CATEGORIES.flatMap(category => {
    const members = rows.filter(row => row.category === category);
    if (!members.length) return [];
    const clusters: InboxCluster[] = [];
    const byAsk = new Map<string, InboxCluster>();
    for (const row of members) {
      const ask = inboxAsk(row);
      const key = `${row.source}:${ask}`;
      const existing = byAsk.get(key);
      if (existing) existing.rows.push(row);
      else { const cluster = { ask, rows: [row] }; byAsk.set(key, cluster); clusters.push(cluster); }
    }
    return [{ category, count: members.length, clusters }];
  });
}
/** Rows in the exact order the grouped list renders them, for paging and keyboard order. */
export const inboxDisplayOrder = (rows: readonly InboxRow[]): InboxRow[] => groupInbox(rows).flatMap(section => section.clusters.flatMap(cluster => cluster.rows));
export function inboxSourceStatus(agents: AgentOverview | null, delivery: DeliveryQueueData | null, errors: { agents: string; delivery: string }) {
  return { agentCount: agents?.runs.length ?? 0, agentsCapped: (agents?.runs.length ?? 0) >= 200, deliveryCount: delivery?.entries.length ?? 0, unavailable: Object.entries(errors).filter(([, error]) => !!error).map(([source]) => source) };
}
