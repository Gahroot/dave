import type { Db } from "../db/index.ts";
import { isOpen, titleMatches } from "../intel/scope.ts";
import type { IntelItem, Objective } from "../intel/types.ts";
import { DAVE_ID, type NewWorkEvent, type WorkLink } from "./types.ts";

export type LinkResult = { objectiveId: string | null; itemIds: string[]; link: WorkLink };

function loggedTargets(db: Db, objectiveId: string): string[] | null {
  try {
    const r = db.prepare("SELECT target_item_ids_json FROM recommendation_log WHERE objective_id=? ORDER BY recommended_at DESC, id DESC LIMIT 1").get(objectiveId) as
      { target_item_ids_json: string } | undefined;
    if (!r) return null;
    const v: unknown = JSON.parse(r.target_item_ids_json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && DAVE_ID.test(x)) : null;
  } catch { return null; }
}

/**
 * Ties a work event to the plan. An explicit `DAVE-Objective:` marker wins: its target items come from the newest
 * recommendation_log row for that objective, else the objective DAVE currently shows, else the `DAVE-Items:` marker.
 * Without a marker, open requirement, milestone and commitment titles are matched against the event text.
 */
export function linkEvent(db: Db, e: NewWorkEvent, items: IntelItem[], objectives: Objective[]): LinkResult {
  const known = new Set(items.map((i) => i.id));
  const keep = (ids: string[]): string[] => [...new Set(ids.filter((id) => known.has(id)))].sort();
  const { objectiveId } = e.marker;
  if (objectiveId) {
    const targets = loggedTargets(db, objectiveId) ?? objectives.find((o) => o.id === objectiveId)?.targetItemIds ?? e.marker.itemIds;
    const ids = keep(targets);
    return { objectiveId, itemIds: ids.length ? ids : keep(e.marker.itemIds), link: "explicit" };
  }
  if (e.marker.itemIds.length) {
    const ids = keep(e.marker.itemIds);
    if (ids.length) return { objectiveId: null, itemIds: ids, link: "explicit" };
  }
  const text = `${e.title} ${e.summary ?? ""}`;
  const hits = items.filter((i) => (i.kind === "requirement" || i.kind === "milestone" || i.kind === "commitment") && isOpen(i) && titleMatches(i.title, text));
  if (!hits.length) return { objectiveId: null, itemIds: [], link: "none" };
  const ids = keep(hits.map((i) => i.id));
  const obj = objectives.find((o) => o.targetItemIds.some((id) => ids.includes(id)));
  return { objectiveId: obj?.id ?? null, itemIds: ids, link: "title" };
}
