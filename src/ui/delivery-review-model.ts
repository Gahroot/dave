import type { EvidenceResult } from "../model/delivery-coordination.ts";
import { reportFailures } from "../model/delivery-progress.ts";

/** Describes reported evidence, never independent verification or a workflow state. */
export function summarizeReview(report: EvidenceResult): {
  criteria: { met: number; failed: number; unknown: number };
  commands: { passed: number; failed: number; notRun: number };
  failures: string[];
  canAccept: boolean;
} {
  const failures = reportFailures(report);
  return {
    criteria: { met: report.criteria.filter(c => c.status === "met").length, failed: report.criteria.filter(c => c.status === "unmet").length, unknown: report.criteria.filter(c => c.status === "unknown").length },
    commands: { passed: report.commands.filter(c => c.exitCode === 0).length, failed: report.commands.filter(c => c.exitCode !== null && c.exitCode !== 0).length, notRun: report.commands.filter(c => c.exitCode === null).length },
    failures, canAccept: failures.length === 0,
  };
}
