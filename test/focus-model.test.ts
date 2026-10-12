import { describe, expect, it } from "vitest";
import type { IntelItem, Objective, Proposal, ProjectFocusRow, Provenance, SourceHealth } from "../src/intel/types.ts";
import {
  agoLabel, briefMode, countLine, dueState, evidenceFreshness, freshnessText, groupItemsByKind, isFirstRun, meetingCommitments,
  parseLines, proposalOrigin, readinessCells, readinessSummary, safeLink, sortDecisions, sortProjectRows, sourceWarning,
} from "../src/ui/focus-model.ts";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const prov = (over: Partial<Provenance> = {}): Provenance => ({ sourceKind: "meeting", sourceId: "m1", label: "Call", quote: null, observedAt: "2026-10-10T00:00:00Z", confidence: "medium", link: null, ...over });
const item = (over: Partial<IntelItem>): IntelItem => ({
  id: "i", projectId: "p", kind: "requirement", title: "T", detail: null, basis: "inferred", status: "open", evidenceState: "unknown",
  readinessTarget: null, readinessReached: null, owner: "me", dueDate: null, acceptance: [], dependsOn: [], locked: false, provenance: [],
  lastSupportedAt: "2026-10-10T00:00:00Z", createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z", ...over,
});
const row = (over: Partial<ProjectFocusRow>): ProjectFocusRow => ({
  projectId: "p", projectName: "P", stage: "building", outcome: null, outcomeBasis: null, objective: null, readinessReached: null,
  counts: { requirements: 0, milestonesDone: 0, milestonesTotal: 0, openBlockers: 0, pendingProposals: 0 }, nextCommitment: null,
  freshness: "fresh", lastReconciledAt: null, ...over,
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
  it("parses multi-line lists", () => {
    expect(parseLines(" a \r\n\n b\n")).toEqual(["a", "b"]);
    expect(parseLines("1\n2\n3", 2)).toEqual(["1", "2"]);
  });
});
