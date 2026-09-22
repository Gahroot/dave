import { ATTENTION, type AgentOverview, type AgentRun } from "../agents/types.ts";
import type { InboxItem } from "../shared/types.ts";
import type { QueueEntry } from "../model/delivery-queue.ts";
import type { InboxFilter } from "./navigation.ts";

export type DeliveryQueueData = { limit: number; entries: QueueEntry[] };
export type InboxRow = {
  key: string; source: "agent" | "delivery" | "request"; id: string;
  project: string; title: string; reason: string; timestamp: string | null;
  category: Exclude<InboxFilter, "all">;
} & ({ source: "agent"; value: AgentRun } | { source: "delivery"; value: QueueEntry } | { source: "request"; value: InboxItem });
export function normalizeInbox(requests: InboxItem[], agents: AgentOverview | null, delivery: DeliveryQueueData | null): InboxRow[] {
  const rows: InboxRow[] = [
    ...(agents?.runs ?? []).filter(run => ATTENTION.includes(run.status)).map((run): InboxRow => ({ key: `agent:${run.id}`, source: "agent", id: run.id, project: run.projectName, title: run.title, reason: run.status === "waiting" ? "Permission requested" : run.reason || "Review agent evidence", timestamp: run.updatedAt, category: "decision", value: run })),
    ...(delivery?.entries ?? []).map((entry): InboxRow => ({ key: `delivery:${entry.projectId}`, source: "delivery", id: entry.projectId, project: entry.projectName, title: entry.step.headline, reason: entry.step.why, timestamp: entry.startedAt, category: entry.state === "paused" || entry.step.kind === "waiting" || entry.step.kind === "unblock" ? "waiting" : ["send", "setup", "scope", "plan"].includes(entry.step.kind) ? "ready" : "decision", value: entry })),
    ...requests.map((item): InboxRow => ({ key: `request:${item.id}`, source: "request", id: item.id, project: item.projectName ?? "Project unavailable", title: item.detail || item.title, reason: item.projectName && item.title.startsWith(`${item.projectName}: `) ? item.title.slice(item.projectName.length + 2) : item.title, timestamp: item.lastObservedAt, category: item.kind === "inspection" ? "ready" : "decision", value: item })),
  ];
  const seen = new Set<string>();
  return rows.filter(row => { if (seen.has(row.key)) return false; seen.add(row.key); return true; });
}
export function inboxSourceStatus(agents: AgentOverview | null, delivery: DeliveryQueueData | null, errors: { agents: string; delivery: string }) {
  return { agentCount: agents?.runs.length ?? 0, agentsCapped: (agents?.runs.length ?? 0) >= 200, deliveryCount: delivery?.entries.length ?? 0, unavailable: Object.entries(errors).filter(([, error]) => !!error).map(([source]) => source) };
}
