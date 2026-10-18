import { describe, expect, it } from "vitest";
import type { DeliveryProgress, IntelItem, Move, Objective, Proposal, ProjectFocusRow, Provenance, SourceHealth } from "../src/intel/types.ts";
import {
  agoLabel, behindBand, behindLine, briefMode, countLine, dueState, evidenceFreshness, freshnessText, groupDecisions, groupItemsByKind, homeGroups, homePulse, isFirstRun, meetingCommitments,
  parseLines, progressLine, proposalOrigin, readinessCells, readinessSummary, safeLink, sortDecisions, sortProjectRows, sourceWarning, stepCells,
  stepLabel, visibleMoves,
} from "../src/ui/focus-model.ts";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const prov = (over: Partial<Provenance> = {}): Provenance => ({ sourceKind: "meeting", sourceId: "m1", label: "Call", quote: null, observedAt: "2026-10-10T00:00:00Z", confidence: "medium", link: null, ...over });
const item = (over: Partial<IntelItem>): IntelItem => ({
  id: "i", projectId: "p", kind: "requirement", title: "T", detail: null, basis: "inferred", status: "open", evidenceState: "unknown",
  readinessTarget: null, readinessReached: null, owner: "me", dueDate: null, acceptance: [], dependsOn: [], locked: false, provenance: [],
  lastSupportedAt: "2026-10-10T00:00:00Z", createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z",
  lane: null, goal: null, verifiedAt: null, sentAt: null, reopenCount: 0, ...over,
});
const progress = (over: Partial<DeliveryProgress> = {}): DeliveryProgress => ({
  confirmed: true, delivered: false, percentDone: 0, finishLineItems: 0, verifiedItems: 0,
  steps: { production_ready: false, live: false, using: false, signed_off: false }, currentStep: "production_ready", stepNumber: 1,
  startDate: "2026-10-01", targetDate: null, suggestedTargetDate: null, lastRealProgressAt: null, lastClientSeenAt: null, unseenByClient: 0,
  waitingOnClient: false, overdue: false,
  behind: { score: 0, schedule: null, distance: 100, stalled: 0, stalledDays: 0, weights: { schedule: 0, distance: 0.6, stalled: 0.4 } }, ...over,
});
const scored = (score: number, percentDone = 0): Partial<DeliveryProgress> => ({
  percentDone, behind: { score, schedule: null, distance: 100 - percentDone, stalled: 0, stalledDays: 0, weights: { schedule: 0, distance: 0.6, stalled: 0.4 } },
});
const row = (over: Partial<ProjectFocusRow>): ProjectFocusRow => ({
  projectId: "p", projectName: "P", stage: "building", outcome: null, outcomeBasis: null, objective: null, readinessReached: null,
  counts: { requirements: 0, milestonesDone: 0, milestonesTotal: 0, openBlockers: 0, pendingProposals: 0 }, nextCommitment: null,
  freshness: "fresh", lastReconciledAt: null, delivery: progress(), nextMove: null, paidWhen: null, priority: null, ...over,
});
const proposal = (over: Partial<Proposal>): Proposal => ({
  id: "x", projectId: "p", projectName: "P", kind: "scope_change", material: false, summary: "s", detail: null, itemId: null, patch: {},
  provenance: [], status: "pending", createdAt: "2026-10-01T00:00:00Z", resolvedAt: null, ...over,
});

describe("focus model", () => {
  it("keeps the four readiness levels separate and never says done", () => {
    expect(readinessCells(null).every(c => !c.reached)).toBe(true);
    expect(readinessCells("deployed").map(c => c.reached)).toEqual([true, true, false, false]);
    expect(readinessSummary(null)).toBe("No readiness evidenced yet");
    expect(readinessSummary("code_complete")).not.toMatch(/done/i);
  });
  it("words freshness without implying current when unknown", () => {
    expect(agoLabel(null, NOW)).toBe("never");
    expect(agoLabel("2026-10-12T11:00:00Z", NOW)).toBe("1 h ago");
    expect(agoLabel("2026-10-09T12:00:00Z", NOW)).toBe("3 days ago");
    expect(freshnessText("never", null, NOW)).toMatch(/nothing here is confirmed current/);
    expect(freshnessText("stale", "2026-09-01T00:00:00Z", NOW)).toMatch(/out of date/);
    expect(evidenceFreshness("2026-10-10T00:00:00Z", NOW)).toBe("fresh");
    expect(evidenceFreshness("2026-09-01T00:00:00Z", NOW)).toBe("stale");
    expect(evidenceFreshness("junk", NOW)).toBe("never");
  });
  it("classifies due dates", () => {
    expect(dueState(null, NOW).kind).toBe("none");
    expect(dueState("2026-10-10", NOW).kind).toBe("overdue");
    expect(dueState("2026-10-12", NOW).kind).toBe("today");
    expect(dueState("2026-10-15", NOW).kind).toBe("soon");
    expect(dueState("2026-12-01", NOW).kind).toBe("later");
    expect(dueState("not a date", NOW).kind).toBe("none");
  });
  it("follows only in-app links", () => {
    expect(safeLink("#meetings?rec=123")).toBe("#meetings?rec=123");
    expect(safeLink("javascript:alert(1)")).toBeNull();
    expect(safeLink("https://evil.example")).toBeNull();
    expect(safeLink(null)).toBeNull();
  });
  it("sorts project rows by score then freshness then name, deterministically", () => {
    const obj = (score: number) => ({ score }) as Objective;
    const rows = [row({ projectId: "c", projectName: "C" }), row({ projectId: "a", projectName: "A", objective: obj(5) }), row({ projectId: "b", projectName: "B", objective: obj(9) }), row({ projectId: "d", projectName: "D", freshness: "stale" })];
    expect(sortProjectRows(rows).map(r => r.projectId)).toEqual(["b", "a", "d", "c"]);
  });
  it("puts material, oldest decisions first and drops resolved ones", () => {
    const out = sortDecisions([
      proposal({ id: "1", createdAt: "2026-10-02T00:00:00Z" }), proposal({ id: "2", material: true, createdAt: "2026-10-05T00:00:00Z" }),
      proposal({ id: "3", createdAt: "2026-10-01T00:00:00Z" }), proposal({ id: "4", status: "accepted" }),
    ]);
    expect(out.map(p => p.id)).toEqual(["2", "3", "1"]);
  });
  it("tells confirmed provenance from inferred", () => {
    expect(proposalOrigin(proposal({ provenance: [prov({ sourceKind: "human" })] }))).toBe("confirmed");
    expect(proposalOrigin(proposal({ provenance: [prov({ sourceKind: "human" }), prov()] }))).toBe("inferred");
    expect(proposalOrigin(proposal({}))).toBe("inferred");
  });
  it("groups items by kind with open work first", () => {
    const groups = groupItemsByKind([item({ id: "a", kind: "requirement", status: "done", title: "A" }), item({ id: "b", kind: "requirement", title: "B" }), item({ id: "c", kind: "milestone" })]);
    expect(groups.map(g => g.kind)).toEqual(["milestone", "requirement"]);
    expect(groups[1]?.items.map(i => i.id)).toEqual(["b", "a"]);
  });
  it("finds open meeting-derived commitments only", () => {
    const out = meetingCommitments([
      item({ id: "a", kind: "commitment", provenance: [prov()] }), item({ id: "b", kind: "commitment", provenance: [prov({ sourceKind: "human" })] }),
      item({ id: "c", kind: "commitment", status: "done", provenance: [prov()] }),
    ]);
    expect(out.map(i => i.id)).toEqual(["a"]);
  });
  it("offers a brief only for developer-startable objectives", () => {
    expect(briefMode({ humanOnly: true, brief: null } as Objective)).toBe("human");
    expect(briefMode({ humanOnly: false, brief: "do it" } as Objective)).toBe("copy");
    expect(briefMode({ humanOnly: false, brief: "  " } as Objective)).toBe("none");
  });
  it("flags degraded, unavailable and old syncs on the sources strip", () => {
    const s = (over: Partial<SourceHealth>): SourceHealth => ({ source: "git", state: "ok", lastSyncAt: "2026-10-12T11:00:00Z", detail: null, ...over });
    expect(sourceWarning(s({}), NOW)).toBeNull();
    expect(sourceWarning(s({ state: "degraded", detail: "rate limited" }), NOW)).toBe("rate limited");
    expect(sourceWarning(s({ state: "unavailable" }), NOW)).toMatch(/unavailable/i);
    expect(sourceWarning(s({ lastSyncAt: "2026-10-01T00:00:00Z" }), NOW)).toMatch(/out of date/);
    expect(sourceWarning(s({ lastSyncAt: null }), NOW)).toMatch(/Never synced/);
    expect(sourceWarning(s({ state: "not_connected", lastSyncAt: null }), NOW)).toBeNull();
  });
  it("summarises counts and detects first run", () => {
    expect(countLine({ requirements: 1, milestonesDone: 2, milestonesTotal: 5, openBlockers: 0, pendingProposals: 3 })).toBe("1 requirement · 2 of 5 milestones done · 3 awaiting you");
    expect(isFirstRun({ top: null, projects: [row({})], lastReconciledAt: null })).toBe(true);
    expect(isFirstRun({ top: null, projects: [row({})], lastReconciledAt: "2026-10-01T00:00:00Z" })).toBe(false);
  });
  it("groups the home: confirmed projects most behind first, then by least done and name; setup and delivered apart", () => {
    const rows = [
      row({ projectId: "z", projectName: "Zeta", delivery: progress(scored(40, 50)) }),
      row({ projectId: "a", projectName: "Acme", delivery: progress(scored(52, 40)) }),
      row({ projectId: "b", projectName: "Beta", delivery: progress(scored(40, 20)) }),
      row({ projectId: "g", projectName: "Gamma", delivery: progress(scored(40, 50)) }),
      row({ projectId: "u", projectName: "Unset", delivery: progress({ confirmed: false, behind: null }) }),
      row({ projectId: "d", projectName: "Done", delivery: progress({ delivered: true, currentStep: null, stepNumber: 5 }) }),
    ];
    const g = homeGroups(rows);
    expect(g.ranked.map(r => r.projectId)).toEqual(["a", "b", "g", "z"]);
    expect(g.setup.map(r => r.projectId)).toEqual(["u"]);
    expect(g.delivered.map(r => r.projectId)).toEqual(["d"]);
    expect(homeGroups([...rows].reverse())).toEqual(g);
  });
  it("labels the step, the score's parts and progress in words", () => {
    expect(stepLabel(progress({ currentStep: "live", stepNumber: 2 }))).toBe("Step 2 of 4: Go live");
    expect(stepLabel(progress({ confirmed: false }))).toBe("Finish line not confirmed");
    expect(stepLabel(progress({ delivered: true, currentStep: null, stepNumber: 5 }))).toBe("Delivered: signed off");
    expect(stepCells(progress({ steps: { production_ready: false, live: true, using: false, signed_off: false } })).map(c => [c.step, c.reached, c.current]))
      .toEqual([["production_ready", false, true], ["live", true, false], ["using", false, false], ["signed_off", false, false]]);
    expect(behindLine(progress({ behind: { score: 52, schedule: 60, distance: 60, stalled: 21, stalledDays: 3, weights: { schedule: 0.5, distance: 0.3, stalled: 0.2 } } })))
      .toBe("Behind schedule 60 · Distance 60 · Stalled 21 (3 days)");
    expect(behindLine(progress({ behind: { score: 46, schedule: null, distance: 30, stalled: 7, stalledDays: 1, weights: { schedule: 0, distance: 0.6, stalled: 0.4 } } })))
      .toBe("No target date · Distance 30 · Stalled 7 (1 day)");
    expect(behindLine(progress({ confirmed: false, behind: null }))).toMatch(/not scored/i);
    expect(progressLine(progress({ finishLineItems: 9, verifiedItems: 5, percentDone: 49 }))).toBe("5 of 9 verified · 49% done");
    expect(progressLine(progress())).toBe("No finish-line items yet · 0% done");
  });
  it("shows at most three moves and keeps the rest", () => {
    const m = (id: string): Move => ({ id, kind: "verify", title: id, why: "", itemId: null, proposalId: null, proposalKind: null, step: null, suggestedDate: null, doneWhen: [] });
    const out = visibleMoves([m("1"), m("2"), m("3"), m("4"), m("5")]);
    expect(out.shown.map(x => x.id)).toEqual(["1", "2", "3"]);
    expect(out.more.map(x => x.id)).toEqual(["4", "5"]);
    expect(visibleMoves([m("1")])).toEqual({ shown: [m("1")], more: [] });
  });
  it("bands the behind score at 70 and 40, and never colours without the number", () => {
    expect(behindBand(100)).toEqual({ tone: "red", label: "Far behind" });
    expect(behindBand(70)).toEqual({ tone: "red", label: "Far behind" });
    expect(behindBand(69)).toEqual({ tone: "amber", label: "Behind" });
    expect(behindBand(40)).toEqual({ tone: "amber", label: "Behind" });
    expect(behindBand(39)).toEqual({ tone: "blue", label: "On pace" });
    expect(behindBand(0)).toEqual({ tone: "blue", label: "On pace" });
  });
  it("groups decisions by project in their given order and counts today from real rows", () => {
    const d = (id: string, projectId: string) => ({ id, projectId, projectName: projectId.toUpperCase() });
    expect(groupDecisions([d("1", "b"), d("2", "a"), d("3", "b")])).toEqual([
      { projectId: "b", projectName: "B", decisions: [d("1", "b"), d("3", "b")] },
      { projectId: "a", projectName: "A", decisions: [d("2", "a")] },
    ]);
    expect(groupDecisions([])).toEqual([]);
    const projects = [
      row({ projectId: "a", delivery: progress({ overdue: true, waitingOnClient: true }) }),
      row({ projectId: "b", delivery: progress({ waitingOnClient: true }) }),
      row({ projectId: "c", delivery: progress({ confirmed: false, behind: null, overdue: true, waitingOnClient: true }) }),
      row({ projectId: "d", delivery: progress({ delivered: true, overdue: true }) }),
    ];
    expect(homePulse({ projects, decisions: [1, 2, 3] })).toEqual({ inDelivery: 2, overdue: 1, decisions: 3, waitingOnClient: 2 });
  });
  it("parses multi-line lists", () => {
    expect(parseLines(" a \r\n\n b\n")).toEqual(["a", "b"]);
    expect(parseLines("1\n2\n3", 2)).toEqual(["1", "2"]);
  });
});
