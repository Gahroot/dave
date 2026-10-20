import { describe, expect, it } from "vitest";
import { buildRoadmap, coverage } from "../src/model/roadmap.ts";
import type { DeliveryState } from "../src/model/delivery-schema.ts";
import type { CoordinationState } from "../src/model/delivery-coordination.ts";
import type { MeetingItem } from "../src/meetings/types.ts";

const goal = { goal: "Client portal for invoices", intendedUser: "accountants", workflow: "view invoices", stage: "pilot", provider: null, model: null, consent: null };
const state = { projectId: "p", revision: 1, goal, currentPlanId: "plan", currentMilestoneId: null, history: [], nextPlans: [],
  plans: [{ id: "plan", revision: 1, goal, assumptions: [], createdAt: "2026-10-01T00:00:00Z", milestones: [
    { id: "m0", position: 0, title: "Invoice list page", outcome: "Accountants can view invoices", whyNow: "", scope: ["list invoices"], exclusions: [], acceptance: ["invoices listed", "filter by date"], sourceIds: [], humanPrerequisites: [], dependencies: [], status: "pending", blockedReason: null, completedAt: null }] }] } as unknown as DeliveryState;
const coordination = { goalMatches: true, contract: { id: "c", goalHash: "h", outcome: "Accountants view and download invoices", exclusions: [], criteria: [{ text: "Invoices can be downloaded as PDF", milestones: [0] }, { text: "Login works", milestones: [0] }], prerequisites: [] }, handoffs: [], reports: [], decisions: [], resolutions: {} } as unknown as CoordinationState;
const item = (over: Partial<MeetingItem>): MeetingItem => ({ id: "i", recordingId: "1", kind: "pain_point", text: "Wants invoices downloaded as PDF", quote: "q", atSeconds: 0, speaker: "c", speakerRole: "client", projectId: "p", projectName: "P", projectSource: "user", duePhrase: null, dueDate: null, feature: null, status: "open", suggestedStatus: null, statusSource: "model", statusNote: null, statusChangedAt: null, edited: false, agentRunId: null, strength: "firm", strengthSource: null, deliverable: null, createdAt: "", updatedAt: "", meetingTitle: "Weekly", meetingAt: "2026-10-05T00:00:00Z", meetingUrl: null, ...over });
const run = (items: MeetingItem[], s = state) => buildRoadmap({ projectId: "p", projectName: "P", state: s, coordination, items });

describe("roadmap", () => {
  it("measures how much of a requirement the plan already says", () => {
    expect(coverage("download invoices as PDF", "Invoices can be downloaded as PDF")).toBeGreaterThanOrEqual(0.5);
    expect(coverage("single sign-on with Okta", "download invoices as PDF")).toBe(0);
  });
  it("reports the finish line and progress for a complete roadmap", () => {
    const r = run([]);
    expect(r.finish).toBe("Accountants view and download invoices");
    expect(r.progress).toMatchObject({ milestonesTotal: 1, milestonesAccepted: 0, criteriaTotal: 2 });
    expect(r.problem).toBeNull();
  });
  it("does not flag asks the plan already covers, or ones that look done", () => {
    expect(run([item({}), item({ id: "d", status: "looks_done", text: "Okta sign-on" })]).gaps).toEqual([]);
  });
  it("flags uncovered asks and promises, promises first, and marks ones newer than the plan", () => {
    const gaps = run([
      item({ id: "ask", text: "Needs single sign-on with Okta", meetingAt: "2026-10-08T00:00:00Z" }),
      item({ id: "pro", kind: "commitment", text: "Send staging credentials to the client", dueDate: "2026-10-14" }),
      item({ id: "dec", kind: "decision", text: "Use Okta" }),
    ]).gaps;
    expect(gaps.map(g => [g.itemId, g.kind, g.newSincePlan])).toEqual([["pro", "promise", true], ["ask", "client-ask", true]]);
  });
  it("says why the roadmap cannot be trusted yet", () => {
    expect(run([], { ...state, goal: null }).problem).toMatch(/goal/);
    expect(buildRoadmap({ projectId: "p", projectName: "P", state, coordination: { ...coordination, contract: null }, items: [] }).problem).toMatch(/finish line/);
  });
});
