/**
 * The live context block appended to DAVE's instructions. Bounded, speakable, never meeting transcripts or quotes.
 */
import type { DirectionNote, Freshness, Lane } from "../intel/types.ts";
import type { PageContext } from "./types.ts";
import type { VoiceIntel } from "./deps.ts";
import { speakable } from "./safety.ts";

export const CONTEXT_MAX_CHARS = 6000;

export type GapInput = {
  projectName: string;
  hasFinishLine: boolean;
  paidWhen: string | null;
  targetDate: string | null;
  focusItems: { id: string; title: string; lane: Lane | null }[];
  topObjectiveTargets: string[] | null;
  freshness: Freshness;
};

/** Plain-words gaps between what you want and what DAVE knows. Pure. */
export function alignmentGaps(g: GapInput): string[] {
  const out: string[] = [];
  const n = g.projectName;
  if (!g.hasFinishLine) out.push(`${n} has no finish line yet.`);
  if (!g.paidWhen) out.push(`${n} has no "paid when" yet.`);
  if (g.hasFinishLine && !g.targetDate) out.push(`${n} has no target date.`);
  for (const f of g.focusItems) if (f.lane === "extra" || f.lane === "phase2") out.push(`${n}: "${f.title}" matters most to you but is filed under ${f.lane === "extra" ? "extras" : "phase 2"}.`);
  if (g.focusItems.length && g.topObjectiveTargets && !g.topObjectiveTargets.some((id) => g.focusItems.some((f) => f.id === id))) out.push(`${n}: DAVE's top pick does not work on what you said matters most.`);
  if (g.freshness === "stale") out.push(`${n}: DAVE's picture is more than a day old.`);
  if (g.freshness === "never") out.push(`${n} was never checked by DAVE.`);
  return out.map((s) => speakable(s, 240));
}

export type ContextDeps = {
  intel: VoiceIntel;
  lastSummary: () => string | null;
  projectName: (id: string) => string | null;
};

/** Gaps for one project from the intel service. */
export function projectGaps(intel: VoiceIntel, projectId: string): string[] {
  const pi = intel.projectIntel(projectId);
  const items = new Map(pi.items.map((i) => [i.id, i]));
  return alignmentGaps({
    projectName: pi.projectName,
    hasFinishLine: !!pi.outcome,
    paidWhen: pi.direction.paidWhen,
    targetDate: pi.plan.progress.targetDate,
    focusItems: pi.direction.focusItemIds.flatMap((id) => { const i = items.get(id); return i ? [{ id, title: i.title, lane: i.lane }] : []; }),
    topObjectiveTargets: pi.objective ? pi.objective.targetItemIds : null,
    freshness: pi.freshness,
  });
}

const noteLine = (n: DirectionNote, name: (id: string) => string | null): string =>
  `- ${n.createdAt.slice(0, 10)}${n.projectId ? ` (${name(n.projectId) ?? "a project"})` : ""}: ${speakable(n.text, 200)}`;

export function voiceContext(deps: ContextDeps, page: PageContext, now: Date): string {
  const lines: string[] = [];
  const s = (t: string, max = 200) => speakable(t, max);
  lines.push("## Live context (from DAVE's own records)");
  lines.push(`Today is ${now.toISOString().slice(0, 10)}.`);
  const here = page.projectId ? deps.projectName(page.projectId) : null;
  lines.push(`The user is on the ${s(page.route.replace(/^#/, "").split(/[?/]/)[0] || "focus", 40)} page${here ? `, looking at ${s(here, 80)}` : ""}.`);
  let gaps: string[] = [];
  try {
    const focus = deps.intel.focus();
    const rows = focus.projects.slice(0, 6);
    if (rows.length) {
      lines.push("Projects (DAVE's recommended order):");
      for (const r of rows) {
        let paid: string | null = null, priority: number | null = null;
        try { const d = deps.intel.direction(r.projectId); paid = d.paidWhen; priority = d.priority; } catch { /* direction unavailable */ }
        const behind = r.delivery.behind ? `behind score ${r.delivery.behind.score}` : "finish line not confirmed";
        lines.push(`- ${s(r.projectName, 60)} [id ${r.projectId}]: finish line ${r.outcome ? `"${s(r.outcome, 160)}"` : "not set"}; paid when ${paid ? `"${s(paid, 120)}"` : "not set"}; priority ${priority ?? "none"}; ${behind}; next move: ${r.nextMove ? s(r.nextMove, 120) : "none"}.`);
      }
    }
    const missing = focus.projects.filter((r) => !r.outcome).map((r) => s(r.projectName, 60));
    if (missing.length) lines.push(`No finish line yet: ${missing.slice(0, 10).join(", ")}.`);
    if (focus.decisions.length) {
      lines.push(`Decisions waiting (${focus.decisions.length}):`);
      for (const d of focus.decisions.slice(0, 3)) lines.push(`- ${s(d.projectName, 60)}: ${s(d.summary, 160)}`);
    }
    const today = now.toISOString().slice(0, 10);
    const overdue = focus.external.commitments.filter((c) => c.dueDate && c.dueDate < today);
    if (overdue.length) {
      lines.push("Overdue commitments:");
      for (const c of overdue.slice(0, 5)) lines.push(`- ${s(c.projectName, 60)}: ${s(c.title, 140)} (due ${c.dueDate})`);
    }
    const order = page.projectId ? [page.projectId, ...rows.map((r) => r.projectId).filter((id) => id !== page.projectId)] : rows.map((r) => r.projectId);
    for (const id of order.slice(0, 6)) { try { gaps.push(...projectGaps(deps.intel, id)); } catch { /* unknown project */ } }
  } catch { lines.push("DAVE's delivery picture is not available right now."); }
  gaps = gaps.slice(0, 10);
  if (gaps.length) { lines.push("Alignment gaps (biggest first):"); for (const g of gaps) lines.push(`- ${g}`); }
  try {
    const notes = deps.intel.directionNotes("all", 8);
    if (notes.length) { lines.push("What the user told DAVE before (newest first):"); for (const n of notes) lines.push(noteLine(n, deps.projectName)); }
  } catch { /* notes unavailable */ }
  const last = deps.lastSummary();
  if (last) lines.push(`Last voice session: ${s(last, 400)}`);
  let out = "";
  for (const l of lines) {
    if (out.length + l.length + 1 > CONTEXT_MAX_CHARS) break;
    out += `${l}\n`;
  }
  return out.trimEnd();
}
