/** Pure helpers for the phone's Clean up screen (no React Native imports). */
import { TRIAGE_BUCKETS, type TriageAction, type TriageBucket, type TriageFilter } from "../../../../src/triage/types.ts";

/** Same rule as the web's navigation bucketOf: anything not a known bucket is ignored. */
export function bucketOf(value: string | string[] | null | undefined): TriageBucket | null {
  const raw = Array.isArray(value) ? value[0] ?? null : value ?? null;
  return TRIAGE_BUCKETS.find((b) => b === raw) ?? null;
}

/** The preview filter the web builds from the project, search and "include confirmed" controls. */
export function cleanupFilter(projectId: string | null, query: string, includeConfirmed: boolean): TriageFilter {
  return { ...(projectId ? { projectId } : {}), ...(query ? { text: query } : {}), ...(includeConfirmed ? { includeConfirmed } : {}) };
}

export function selectedCountText(count: number): string {
  return count === 1 ? "1 selected" : `${count} selected`;
}

export function confirmedHiddenText(n: number): string {
  return n === 1 ? "1 item you confirmed is hidden." : `${n} items you confirmed are hidden.`;
}

/** Consequence text shown in the confirmation before applying. */
export function confirmText(action: TriageAction, count: number): { title: string; message: string; confirmLabel: string } {
  const what = count === 1 ? "1 item" : `${count} items`;
  return action === "clear"
    ? { title: `Clear ${what}?`, confirmLabel: `Clear ${count}`,
      message: "Clearing never deletes: each one is marked dropped everywhere it shows (meeting promise, Inbox row, inferred plan item and drafted decisions). Plan items you locked are kept. You can undo this batch; Undo restores only rows still exactly as this batch left them." }
    : { title: `Mark ${what} done?`, confirmLabel: `Mark ${count} done`,
      message: "Each one is marked done everywhere it shows. Plan items you locked are kept. You can undo this batch; Undo restores only rows still exactly as this batch left them." };
}
