import { redactSecrets } from "../voice/safety.ts";
import { DAVE_ID, ITEMS_MARKER, OBJECTIVE_MARKER } from "./types.ts";

/** Redacted, single-spaced, at most `max` characters (with an ellipsis when cut). */
export function cleanText(text: string, max: number): string {
  const out = redactSecrets(text).replace(/\s+/g, " ").trim();
  return out.length <= max ? out : `${out.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

const OBJECTIVE_LINE = new RegExp(`${OBJECTIVE_MARKER}:[ \\t]*([a-f0-9]{16})\\b`);
const ITEMS_LINE = new RegExp(`${ITEMS_MARKER}:[ \\t]*([^\\r\\n]*)`);

/** Finds the `DAVE-Objective:` / `DAVE-Items:` markers DAVE writes into every brief. */
export function parseMarkers(text: string): { objectiveId: string | null; itemIds: string[] } {
  const objectiveId = OBJECTIVE_LINE.exec(text)?.[1] ?? null;
  const rawItems = ITEMS_LINE.exec(text)?.[1]?.split("\n", 1)[0] ?? "";
  const itemIds = [...new Set(rawItems.split(",").map((s) => s.trim()).filter((s) => DAVE_ID.test(s)))].sort();
  return { objectiveId, itemIds };
}

/** Text with marker lines removed, for summaries. */
export function withoutMarkers(text: string): string {
  return text.split(/\r?\n/).filter((l) => !l.includes(`${OBJECTIVE_MARKER}:`) && !l.includes(`${ITEMS_MARKER}:`)).join("\n");
}
