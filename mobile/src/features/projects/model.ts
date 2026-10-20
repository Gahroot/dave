/**
 * Pure projects logic for the phone, mirroring src/ui/sections/ProjectsView.tsx,
 * ProjectCard.tsx and components/ProjectNextAction.tsx. No React Native imports.
 */
import { ArrowRight, CircleAlert, CircleCheck, EyeOff, Folder, History, Lightbulb, Pin, type LucideIcon } from "lucide-react";
import type { Portfolio, PortfolioProject, ProjectSummary } from "../../../../src/shared/types.ts";
import { hasHumanRequest } from "../../../../src/core/relevance.ts";
import { relative } from "../../../../src/ui/format.ts";
import { FRESHNESS, type Freshness, type StatusSpec, type Tone } from "../../../../src/ui/status.ts";

export const INFERRED: StatusSpec = { tone: "violet", icon: Lightbulb, label: "Human request inferred" };
export const PINNED: StatusSpec = { tone: "blue", icon: Pin, label: "Pinned" };
export const HIDDEN: StatusSpec = { tone: "gray", icon: EyeOff, label: "Hidden" };
export const PROJECT: StatusSpec = { tone: "gray", icon: Folder, label: "Project" };

export const scanOf = (p: PortfolioProject): Freshness => p.scanStatus ?? "cached";
export const isWaiting = (p: PortfolioProject): boolean => hasHumanRequest(p);

/** The one state a row leads with, most urgent first. */
export function leadSpec(project: PortfolioProject): StatusSpec {
  const scan = scanOf(project);
  if (scan === "unavailable") return FRESHNESS.unavailable;
  if (isWaiting(project)) return INFERRED;
  if (scan === "cached") return FRESHNESS.cached;
  if (project.override.pinned) return PINNED;
  return project.override.hidden ? HIDDEN : PROJECT;
}

/** Exceptions only: checked rows carry no freshness tag. */
export function rowTags(project: PortfolioProject): StatusSpec[] {
  const scan = scanOf(project);
  return [
    scan !== "checked" ? FRESHNESS[scan] : null,
    project.override.pinned ? PINNED : null,
    project.override.hidden ? HIDDEN : null,
    isWaiting(project) ? INFERRED : null,
  ].filter((s): s is StatusSpec => s !== null);
}

/** Middle-truncate a path so the folder name stays visible. */
export function shortPath(path: string, keep = 2): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > keep + 1 ? `…/${parts.slice(-keep).join("/")}` : path;
}

export type ProjectFilters = { query: string; waiting: boolean; hidden: boolean };
export type GroupKey = "active" | "other" | "hidden";
export type ProjectGroup = { key: GroupKey; title: string; projects: PortfolioProject[] };
const GROUP_TITLE: Record<GroupKey, string> = { active: "Active", other: "Other projects", hidden: "Hidden projects" };

export function matches(project: PortfolioProject, f: ProjectFilters): boolean {
  const q = f.query.toLocaleLowerCase();
  return (f.hidden ? project.override.hidden : !project.override.hidden)
    && (!f.waiting || isWaiting(project))
    && `${project.name} ${project.canonicalPath}`.toLocaleLowerCase().includes(q);
}

const pinnedFirst = (a: PortfolioProject, b: PortfolioProject) => Number(b.override.pinned) - Number(a.override.pinned);

/** Groups in portfolio order (active, other, hidden); pinned first inside each. Empty groups dropped. */
export function groupProjects(portfolio: Pick<Portfolio, GroupKey>, f: ProjectFilters): ProjectGroup[] {
  const keys: GroupKey[] = ["active", "other", "hidden"];
  const seen = new Set<string>();
  const groups: ProjectGroup[] = [];
  for (const key of keys) {
    const projects = portfolio[key].filter((p) => { if (seen.has(p.id)) return false; seen.add(p.id); return matches(p, f); }).sort(pinnedFirst);
    if (projects.length) groups.push({ key, title: GROUP_TITLE[key], projects });
  }
  return groups;
}

export function freshnessCounts(projects: readonly PortfolioProject[], hidden: boolean): Record<Freshness, number> {
  const counts: Record<Freshness, number> = { checked: 0, cached: 0, unavailable: 0 };
  for (const p of projects) if (hidden ? p.override.hidden : !p.override.hidden) counts[scanOf(p)] += 1;
  return counts;
}

/** Observed machine facts, phrased as activity rather than progress. */
export function activityLine(p: PortfolioProject): string {
  const a = p.activity;
  const bits = [
    a.branch ? `${a.branch}${a.dirty ? ` · ${a.dirtyFileCount ?? "some"} uncommitted` : ""}` : null,
    a.lastCommitAt ? `commit ${relative(a.lastCommitAt)}` : null,
    a.sessionCount ? `${a.sessionCount} session(s), last ${relative(a.lastAgentSessionAt)}` : null,
    a.openTaskCount ? `${a.openTaskCount} open task(s)` : null,
  ].filter(Boolean);
  return bits.length ? bits.join(" · ") : "No technical activity observed";
}

export type NoteKey = "recentFocus" | "completed" | "unfinished" | "suggestedNextAction";
export const NOTE_MAX = 400;
/** Next action first, then the web's question order. */
export const NOTES: readonly { key: NoteKey; label: string }[] = [
  { key: "suggestedNextAction", label: "Next action" },
  { key: "recentFocus", label: "Most recently worked on" },
  { key: "completed", label: "Appears completed" },
  { key: "unfinished", label: "Unfinished or blocked" },
];

export function noteSpec(key: NoteKey, value: string | null | undefined): StatusSpec {
  const filled = Boolean(value?.trim());
  const pick: Record<NoteKey, { icon: LucideIcon; tone: Tone }> = {
    suggestedNextAction: { icon: ArrowRight, tone: "blue" },
    recentFocus: { icon: History, tone: "gray" },
    completed: { icon: CircleCheck, tone: filled ? "green" : "gray" },
    unfinished: { icon: CircleAlert, tone: filled ? "amber" : "gray" },
  };
  return { ...pick[key], label: "" };
}

export const validTime = (iso: string | null | undefined): iso is string => Boolean(iso) && Number.isFinite(Date.parse(iso ?? ""));

export function noteLabel(key: NoteKey, label: string, s: ProjectSummary): string {
  if (key !== "suggestedNextAction") return label;
  return s.edited && validTime(s.nextActionEditedAt) && s.suggestedNextAction?.trim() ? "Chosen next action" : "Suggested next action";
}

export const editLabel = (key: NoteKey, label: string) => key === "suggestedNextAction" ? "Choose/update next action" : `Correct ${label}`;

export function selectProjectNextAction(portfolio: Pick<Portfolio, "active" | "other">): PortfolioProject | undefined {
  return [...portfolio.active, ...portfolio.other].find((p) => p.override.pinned && !p.override.hidden &&
    p.summary.edited && Boolean(p.summary.suggestedNextAction?.trim()) && validTime(p.summary.nextActionEditedAt));
}

/** Replace one project's summary everywhere it appears. */
export function patchSummary(portfolio: Portfolio, id: string, summary: ProjectSummary): Portfolio {
  const patch = (list: PortfolioProject[]) => list.map((p) => p.id === id ? { ...p, summary } : p);
  return { ...portfolio, active: patch(portfolio.active), other: patch(portfolio.other), hidden: patch(portfolio.hidden) };
}

/** Distinct issue sources, in first-seen order. */
export function issueSources(issues: readonly { adapter: string }[]): string[] {
  return [...new Set(issues.map((i) => i.adapter))];
}
