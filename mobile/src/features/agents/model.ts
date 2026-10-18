/**
 * Pure Agent desk logic shared by the phone screens. Mirrors the web's
 * AgentPlatform / AgentAssignment / AgentRunWorkspace rules exactly.
 * No React Native imports: tested from the root suite.
 */
import { ACTIVE, ATTENTION, parseChecks, type AgentRun, type AgentSettings, type CheckCommand, type RunEvent } from "../../../../src/agents/types.ts";
import type { RunFilter } from "../../../../src/ui/navigation.ts";

export type { RunFilter };

export const FILTERS: readonly (readonly [RunFilter, string])[] = [["all", "All"], ["attention", "Needs attention"], ["active", "Active"], ["queued", "Queued"], ["finished", "Finished"]];

export function inFilter(run: AgentRun, filter: RunFilter): boolean {
  return filter === "all" || filter === "attention" && ATTENTION.includes(run.status) || filter === "active" && ACTIVE.includes(run.status)
    || filter === "queued" && run.status === "queued" || filter === "finished" && (run.status === "accepted" || run.status === "stopped");
}

export function countRuns(runs: readonly AgentRun[], filter: RunFilter): number {
  return runs.filter((run) => inFilter(run, filter)).length;
}

export type ExecutionState = "enabled" | "paused" | "disabled";
export function executionState(settings: AgentSettings): ExecutionState {
  return settings.enabled ? settings.paused ? "paused" : "enabled" : "disabled";
}

/** Same reason line as the web desk row. */
export function runReason(run: AgentRun): string {
  return run.reason || (run.status === "queued" ? "Waiting for capacity, accepted dependencies, and a project slot." : "");
}

// ── Route params (src/ui/navigation.ts rules) ──────────────────────────────

const first = (value: string | string[] | undefined): string | null => (Array.isArray(value) ? value[0] : value) ?? null;
export function runId(value: string | string[] | undefined): string | null {
  const one = first(value);
  return one && /^[a-f0-9-]{36}$/.test(one) ? one : null;
}
export function identifier(value: string | string[] | undefined): string | null {
  const one = first(value);
  return one && /^[a-zA-Z0-9_-]{1,200}$/.test(one) ? one : null;
}
export function meetingItemId(value: string | string[] | undefined): string | null {
  const one = first(value);
  return one && /^mi-[0-9a-f]{24}$/.test(one) ? one : null;
}
export function runFilter(value: string | string[] | undefined): RunFilter {
  const one = first(value);
  return FILTERS.some(([f]) => f === one) ? one as RunFilter : "all";
}

// ── Assignment ─────────────────────────────────────────────────────────────

export const STAGES = ["Assignment", "Checks and dependencies", "Review and start"] as const;

export function criterionList(criteria: string): string[] {
  return criteria.split("\n").filter((value) => value.trim());
}

export function assignmentValid(input: { ready: boolean; project: string; title: string; prompt: string; criteria: string }): boolean {
  const list = criterionList(input.criteria);
  return input.ready && !!input.project && !!input.title.trim() && !!input.prompt.trim() && list.length > 0 && list.length <= 12 && list.every((value) => value.length <= 2000);
}

export function checksError(checks: readonly CheckCommand[]): string {
  try { parseChecks(checks); return ""; } catch (error) { return error instanceof Error ? error.message : "Check the command fields"; }
}

/** How the web shows an approved check: executable, then each argument as a JSON string. */
export function commandLine(check: CheckCommand): string {
  return [check.command, ...check.args.map((arg) => JSON.stringify(arg))].join(" ");
}

export function dependencyCandidates(runs: readonly AgentRun[]): AgentRun[] {
  return runs.filter((r) => r.status !== "accepted" && r.status !== "stopped").slice(0, 30);
}

// ── Run workspace ──────────────────────────────────────────────────────────

/** Append new events after the cursor, keeping the latest 500 like the web. */
export function appendEvents(old: readonly RunEvent[], next: readonly RunEvent[]): { events: RunEvent[]; cursor: number | null } {
  const last = next[next.length - 1];
  if (!last) return { events: [...old], cursor: null };
  return { events: [...old, ...next].slice(-500), cursor: last.seq };
}

export function activityText(events: readonly RunEvent[]): string {
  return events.map((event) => event.kind === "output" ? event.text : `\n[${event.kind}] ${event.text}\n`).join("") || "No activity yet.";
}

export function passingCount(run: AgentRun): number {
  return run.packet?.checks.filter((check) => check.exitCode === 0).length ?? 0;
}

export function pendingChecks(run: AgentRun): CheckCommand[] {
  const done = run.packet?.checks ?? [];
  return run.checks.filter((configured) => !done.some((d) => d.label === configured.label));
}

/** Web gate: evidence, a message, every criterion confirmed, and all checks passing (or manual acknowledgement when none). */
export function acceptBlocked(run: AgentRun, input: { busy: boolean; message: string; confirmed: number; manual: boolean }): boolean {
  const packet = run.packet;
  if (input.busy || !input.message.trim() || !packet || input.confirmed !== run.criteria.length) return true;
  return run.checks.length ? packet.checks.length !== run.checks.length || packet.checks.some((check) => check.exitCode !== 0) : !input.manual;
}

export const canAct = (run: AgentRun): boolean => ["review", "failed", "stopped", "interrupted"].includes(run.status);
export const stoppable = (run: AgentRun): boolean => ACTIVE.includes(run.status) || run.status === "queued";
/** Actions after which the web clears the message draft. */
export const clearsDraft = (action: string): boolean => ["reply", "retry", "accept", "dismiss"].includes(action);

export type ReviewMark = "not-run" | "passed" | "failed";
export function reviewMark(run: AgentRun): ReviewMark {
  if (!run.packet) return "not-run";
  if (run.checks.length && passingCount(run) === run.checks.length) return "passed";
  return run.packet.checks.some((check) => check.exitCode !== 0) ? "failed" : "not-run";
}

export type LadderKey = { reported: "done" | "working" | "unfinished"; checks: "none" | "failed" | "passed" | "not-run"; accepted: boolean; reviewing: boolean };
export function ladderState(run: AgentRun): LadderKey {
  const configured = run.checks.length;
  const results = run.packet?.checks ?? [];
  const reported = !!run.packet || ["review", "checking", "accepted"].includes(run.status);
  return {
    reported: reported ? "done" : stoppable(run) ? "working" : "unfinished",
    checks: !configured ? "none" : results.some((c) => c.exitCode !== 0) ? "failed" : results.length === configured ? "passed" : "not-run",
    accepted: run.status === "accepted",
    reviewing: run.status === "review",
  };
}

export type SettingsDraft = Record<"maxConcurrent" | "maxPerProject" | "reviewLimit" | "timeoutMinutes", string>;
export const LIMITS = [["maxConcurrent", "Active runs across all projects", 6], ["maxPerProject", "Active runs per project", 3], ["reviewLimit", "Pause new starts at this review backlog", 12], ["timeoutMinutes", "Maximum minutes per agent turn", 120]] as const;
