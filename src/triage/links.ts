import type { IntelItem, Proposal } from "../intel/types.ts";

/**
 * Cross-layer links for Clean up: which plan items and drafted decisions came from a meeting item.
 * Pure; no I/O.
 */

const meetingIds = (provenance: IntelItem["provenance"]): string[] =>
  provenance.filter((p) => p.sourceKind === "meeting" && p.sourceId !== null).map((p) => String(p.sourceId));

/** Plan items backed by this meeting item. */
export function linkedIntelItems(intelItems: readonly IntelItem[], meetingItemId: string): IntelItem[] {
  return intelItems.filter((i) => meetingIds(i.provenance).includes(meetingItemId));
}

/** Pending proposals about one of these plan items, or drafted from one of these meeting items. */
export function linkedProposals(pending: readonly Proposal[], intelItemIds: readonly string[], meetingItemIds: readonly string[]): Proposal[] {
  const items = new Set(intelItemIds);
  const meetings = new Set(meetingItemIds);
  return pending.filter((p) => p.status === "pending"
    && ((p.itemId !== null && items.has(p.itemId)) || meetingIds(p.provenance).some((id) => meetings.has(id))));
}

/** Why a linked plan item can't be closed with its meeting item, or null when it can. */
export function keepReason(item: IntelItem, closedMeetingIds: ReadonlySet<string>): string | null {
  if (item.status !== "open" && item.status !== "in_progress") return "Already closed";
  if (item.locked) return "Plan item you locked";
  if (item.basis === "confirmed") return "Plan item you confirmed";
  if (item.provenance.some((p) => p.sourceKind === "human")) return "Plan item you added or confirmed";
  if (item.provenance.some((p) => p.sourceKind === "delivery-plan")) return "Part of the delivery plan";
  if (!meetingIds(item.provenance).every((id) => closedMeetingIds.has(id))) return "Still backed by another meeting";
  return null;
}

/** True only when every meeting behind the item is closed and nothing else (you, the plan) backs it. */
export function closableIntelItem(item: IntelItem, closedMeetingIds: ReadonlySet<string>): boolean {
  return keepReason(item, closedMeetingIds) === null;
}

export { meetingIds as meetingSourceIds };
