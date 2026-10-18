/**
 * Pure helpers for the phone's Focus screens. No React Native imports, no clock:
 * callers pass `now`. Everything domain-specific comes from src/ui/focus-model.ts;
 * this file only adapts the web's DOM-bound bits (hash links, date inputs, plurals).
 */
import type { Lane, Proposal, ProjectIntel, ReadinessLevel } from "../../../../src/intel/types.ts";
import { READINESS_LEVELS } from "../../../../src/intel/types.ts";
import { dueState, safeLink } from "../../../../src/ui/focus-model.ts";
import { LANE, PROMISE_GROUP, type StatusSpec } from "../../../../src/ui/status.ts";

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Inside a panel that is all your moves the tile already says amber; a rail is kept only for red and violet. */
export const railTone = (tone: StatusSpec["tone"]): StatusSpec["tone"] | undefined => tone === "amber" ? undefined : tone;

/** DAVE's lane guess, drawn violet. */
export const guessSpec = (lane: Lane): StatusSpec => ({ ...LANE[lane], tone: "violet", label: `DAVE's guess: ${LANE[lane].label}` });

/** Mutes a spec to calm gray (zero counts, empty panels). */
export const calm = (spec: StatusSpec): StatusSpec => ({ ...spec, tone: "gray" });

export const dueSpec = (dueDate: string | null, now: number): StatusSpec => {
  const kind = dueState(dueDate, now).kind;
  return kind === "overdue" ? PROMISE_GROUP.overdue : kind === "today" || kind === "soon" ? PROMISE_GROUP.due_soon : PROMISE_GROUP.open;
};

/** The outcome text and criteria from an outcome_draft proposal. */
export function draftOf(p: Proposal | null | undefined): { text: string; criteria: string[] } | null {
  if (!p || p.kind !== "outcome_draft" || typeof p.patch.desiredOutcome !== "string") return null;
  const raw = p.patch.acceptanceCriteria;
  return { text: p.patch.desiredOutcome, criteria: Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [] };
}

/** DAVE's pending draft, used to prefill the editor so confirming is an edit, not a blank page. */
export function pendingDraft(data: ProjectIntel): { text: string; criteria: string[] } | null {
  return draftOf(data.proposals.find(x => x.kind === "outcome_draft" && x.status === "pending"));
}

/** Highest readiness any item reached. */
export function highestReadiness(data: ProjectIntel): ReadinessLevel | null {
  const reached = data.items.map(i => i.readinessReached).filter((x): x is ReadinessLevel => !!x);
  return [...reached].sort((a, b) => READINESS_LEVELS.indexOf(b) - READINESS_LEVELS.indexOf(a))[0] ?? null;
}

/** Phone date fields are typed: empty or a real calendar day as YYYY-MM-DD. */
export function dateError(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return "Use YYYY-MM-DD";
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v ? "Not a real date" : null;
}

/** Target label without the repeated ISO date in brackets. */
export function targetLabel(targetDate: string | null, startDate: string | null, now: number): string {
  const target = targetDate ? `Target ${targetDate} (${dueState(targetDate, now).label.replace(/ \(\d{4}-\d{2}-\d{2}\)$/, "")})` : "No target date";
  return `${target}${startDate ? ` · Started ${startDate}` : ""}`;
}

/**
 * The web's in-app hash links (already filtered by safeLink) as phone routes.
 * Unknown targets return null and are shown as text only.
 */
export function linkRoute(link: string | null | undefined): string | null {
  const safe = safeLink(link);
  if (!safe) return null;
  const [head, query = ""] = safe.slice(1).split("?");
  const params = new Map(query.split("&").filter(Boolean).map(kv => {
    const [k = "", v = ""] = kv.split("=");
    let decoded = v;
    try { decoded = decodeURIComponent(v); } catch { decoded = ""; }
    return [k, decoded] as const;
  }));
  const id = (key: string): string | null => {
    const v = params.get(key);
    return v && /^[a-zA-Z0-9_-]{1,200}$/.test(v) ? v : null;
  };
  switch (head) {
    case "focus": { const p = id("project"); return p ? `/focus/${p}` : "/"; }
    case "projects": { const p = id("id") ?? id("project"); return p ? `/project/${p}` : "/projects"; }
    case "meetings": { const r = id("rec") ?? id("id"); return r ? `/meetings/${r}` : "/meetings"; }
    case "queue": return "/queue";
    case "issues": return "/issues";
    case "connections": return "/connections";
    default: return null;
  }
}

/** Short summary of acceptance lines for the agreement checkbox help. */
export function acceptancePreview(lines: readonly string[]): string {
  return lines.slice(0, 3).join(" · ") + (lines.length > 3 ? ` · +${lines.length - 3} more` : "");
}

/** Web's request error wording: 404 means the server lacks intel; edits stay on screen. */
export function intelErrorText(status: number, serverText: string): string {
  const why = status === 404 ? "Delivery intelligence is not available on this server yet." : serverText || "Request failed";
  return `${why} (${status}). Your edits are kept on screen.`;
}
