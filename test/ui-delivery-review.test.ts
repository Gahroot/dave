import { describe, expect, it } from "vitest";
import type { EvidenceResult } from "../src/model/delivery-coordination.ts";
import { summarizeReview } from "../src/ui/delivery-review-model.ts";

function report(): EvidenceResult {
  return { version: 1, projectId: "project", planId: "plan", milestoneId: "milestone", handoffId: "handoff", outcome: "Synthetic outcome", criteria: [{ id: "c0", status: "met", evidence: "Reported evidence" }], commands: [{ command: "npm test", exitCode: 0, evidence: "Reported pass" }], blockers: [], risks: [] };
}
describe("reported review summary", () => {
  it("counts met and passed without claiming independent verification", () => {
    expect(summarizeReview(report())).toEqual({ criteria: { met: 1, failed: 0, unknown: 0 }, commands: { passed: 1, failed: 0, notRun: 0 }, failures: [], canAccept: true });
  });
  it.each(["unmet", "unknown"] as const)("blocks %s criteria", status => {
    const value = report(); value.criteria[0] = { id: "c0", status, evidence: "Unresolved" };
    expect(summarizeReview(value).canAccept).toBe(false);
    expect(summarizeReview(value).criteria[status === "unmet" ? "failed" : "unknown"]).toBe(1);
  });
  it.each([1, -1, null])("blocks command exit %s", exitCode => {
    const value = report(); value.commands[0] = { command: "check", exitCode, evidence: "Not successful" };
    expect(summarizeReview(value).canAccept).toBe(false);
    expect(summarizeReview(value).commands[exitCode === null ? "notRun" : "failed"]).toBe(1);
  });
  it("distinguishes blockers from risks and does not invent unreported commands", () => {
    const value = report(); value.commands = []; value.risks = ["Human review needed"];
    expect(summarizeReview(value).canAccept).toBe(true);
    expect(summarizeReview(value).commands).toEqual({ passed: 0, failed: 0, notRun: 0 });
    value.blockers = ["Missing access"];
    expect(summarizeReview(value)).toMatchObject({ canAccept: false, failures: ["Missing access"] });
  });
});
