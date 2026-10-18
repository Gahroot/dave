/** Pure Inbox helpers for the phone. Mirrors src/ui/sections/TodayView.tsx and InboxView.tsx; no React Native imports. */
import { Archive, Check, CircleCheck, CircleDot, CircleSlash, Clock, Hand, Map as MapIcon } from "lucide-react";
import type { AttentionAction, InboxItem, Portfolio } from "../../../../src/shared/types.ts";
import type { InboxRow } from "../../../../src/ui/inbox-model.ts";
import type { InboxFilter } from "../../../../src/ui/navigation.ts";
import type { Roadmap } from "../../../../src/model/roadmap.ts";
import type { TopAction } from "../../../../src/ui/top-action.ts";
import { INBOX_KIND, NEXT_STEP, RUN_STATUS, type StatusSpec } from "../../../../src/ui/status.ts";

export const PAGE_SIZE = 100;
export const FILTERS: readonly (readonly [InboxFilter, string])[] = [["all", "All"], ["decision", "Needs decision"], ["ready", "Ready to work"], ["waiting", "Waiting"]];

export const YOUR_MOVE: StatusSpec = { tone: "amber", icon: Hand, label: "Your move" };
export const CLEAR: StatusSpec = { tone: "green", icon: CircleCheck, label: "Nothing needs you" };
export const ROADMAP: StatusSpec = { tone: "blue", icon: MapIcon, label: "Roadmaps" };

/** The mark a row leads with: what kind of thing it is and whose move it is. */
export function rowSpec(row: InboxRow): StatusSpec {
  if (row.source === "agent") return RUN_STATUS[row.value.status];
  if (row.source === "delivery") return row.value.state === "paused" ? { ...NEXT_STEP.waiting, tone: "gray", label: "Paused" } : NEXT_STEP[row.value.step.kind];
  return INBOX_KIND[row.value.kind];
}
export function rowSource(row: InboxRow): string {
  if (row.source === "agent") return "Agent run";
  if (row.source === "delivery") return row.value.state === "paused" ? "Delivery, paused" : "Delivery";
  return INBOX_KIND[row.value.kind].label;
}
export const markText = (row: InboxRow): string => row.source === "request" ? rowSource(row) : `${rowSource(row)} · ${rowSpec(row).label}`;

/** Where a row opens on the phone. Requests open in place (null). */
export function rowTarget(row: InboxRow): string | null {
  if (row.source === "agent") return `/agents/${row.id}`;
  if (row.source === "delivery") return `/delivery/${row.id}?today=1`;
  return null;
}
export const deliveryTarget = (projectId: string): string => `/delivery/${projectId}?today=1`;
export function meetingsTarget(item: InboxItem): string | null {
  if (item.kind === "client-idea") return "/(tabs)/meetings?section=asks";
  if (item.kind === "meeting-promise") return "/(tabs)/meetings";
  return null;
}
export function topActionTarget(action: TopAction): { request: string } | { path: string } | null {
  if (action.row) { const path = rowTarget(action.row); return path ? { path } : { request: action.row.id }; }
  return action.gap ? { path: deliveryTarget(action.gap.projectId) } : null;
}
export const topActionReason = (action: TopAction): string => action.row && action.row.reason && action.row.reason !== action.title ? ` ${action.row.reason}` : "";

export const HISTORY_STATE: Readonly<Record<"obsolete" | "snoozed" | "handled" | "dismissed" | "current", StatusSpec>> = {
  obsolete: { tone: "gray", icon: Archive, label: "No longer current" },
  snoozed: { tone: "blue", icon: Clock, label: "Snoozed" },
  handled: { tone: "green", icon: Check, label: "Handled locally" },
  dismissed: { tone: "gray", icon: CircleSlash, label: "Not relevant" },
  current: { tone: "amber", icon: CircleDot, label: "Current" },
};
export const historyState = (item: InboxItem): keyof typeof HISTORY_STATE =>
  !item.active ? "obsolete" : item.snoozedUntil ? "snoozed" : item.status === "acknowledged" ? "handled" : item.status === "dismissed" ? "dismissed" : "current";
export function historyLabel(item: InboxItem): string {
  const state = historyState(item);
  if (state === "snoozed" && item.snoozedUntil) return `Snoozed until ${new Date(item.snoozedUntil).toLocaleString()}`;
  if (state === "obsolete") return "No longer current; Undo cannot revive obsolete evidence.";
  return HISTORY_STATE[state].label;
}
export const historyItems = (portfolio: Portfolio): InboxItem[] => (portfolio.history ?? []).filter((item) => !portfolio.inbox.some((open) => open.id === item.id));

export function resolveMessage(action: AttentionAction): string {
  return action === "undo" ? "Reopened locally if this evidence is still current." : action === "tomorrow" ? "Snoozed until 09:00 tomorrow. See History for the stored deadline." : "Saved locally. Upstream tasks are unchanged.";
}

export const pageCount = (total: number): number => Math.max(1, Math.ceil(total / PAGE_SIZE));
export const pageSlice = <T>(items: readonly T[], page: number): T[] => items.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

export function emptyTitle(page: number, total: number): string {
  return page > 0 ? "No items on this page" : total ? "Nothing matches this filter" : "No current attention in loaded evidence";
}

export function roadmapSummary(r: Roadmap): string {
  return r.problem ? r.problem : `${r.progress.milestonesAccepted} of ${r.progress.milestonesTotal} milestones accepted · ${r.progress.criteriaMet} of ${r.progress.criteriaTotal} finish criteria met`;
}
export function roadmapGapText(r: Roadmap): string | null {
  if (!r.gaps.length) return null;
  return `${r.gaps.length} ${r.gaps.length === 1 ? "requirement is" : "requirements are"} not in the plan: ${r.gaps.slice(0, 3).map((g) => g.text).join("; ")}${r.gaps.length > 3 ? "…" : ""}`;
}

/** In a shared group, a member shows only the sub-line parts that differ from the group's. */
export function rowParts(row: InboxRow, group: { lead: InboxRow; sharedReason: boolean } | null) {
  const title = group ? row.project : row.title;
  const showMark = !group || markText(row) !== markText(group.lead);
  const showReason = !!row.reason && row.reason !== title && (!group || !group.sharedReason);
  return { title, showMark, showReason };
}
