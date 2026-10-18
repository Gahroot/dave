import { describe, expect, it } from "vitest";
import type { MeetingItem } from "../src/meetings/types.ts";
import type { IntelItem, Proposal, Provenance } from "../src/intel/types.ts";
import { classifyNoise, countByBucket, filterEntries } from "../src/triage/noise.ts";
import { closableIntelItem, linkedIntelItems, linkedProposals } from "../src/triage/links.ts";

const NOW = new Date("2026-10-18T09:00:00.000Z");
const SECRET = "SENTINEL-QUOTE-xyz";
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function mi(over: Partial<MeetingItem> & { id: string }): MeetingItem {
  return {
    recordingId: "100", kind: "commitment", text: `Text ${over.id}`, quote: SECRET, atSeconds: 5, speaker: "Me", speakerRole: "me",
    projectId: "p1", projectName: "Acme", projectSource: "user", duePhrase: null, dueDate: null, feature: null, status: "open",
    suggestedStatus: null, statusSource: "model", statusNote: null, statusChangedAt: null, edited: false, agentRunId: null,
    createdAt: daysAgo(40), updatedAt: daysAgo(40), meetingTitle: "Acme weekly", meetingAt: daysAgo(40), meetingUrl: null, ...over,
  };
}
const mprov = (id: string, at = daysAgo(40)): Provenance => ({ sourceKind: "meeting", sourceId: id, label: `Acme weekly, ${at.slice(0, 10)}`, quote: SECRET, observedAt: at, confidence: "medium", link: null });
function intelItem(over: Partial<IntelItem> & { id: string }): IntelItem {
  return {
    projectId: "p1", kind: "commitment", title: "t", detail: null, basis: "inferred", status: "open", evidenceState: "unknown",
    readinessTarget: null, readinessReached: null, owner: "me", dueDate: null, acceptance: [], dependsOn: [], locked: false, provenance: [],
    lastSupportedAt: daysAgo(40), createdAt: daysAgo(40), updatedAt: daysAgo(40), lane: null, goal: null, verifiedAt: null, sentAt: null, reopenCount: 0, ...over,
  };
}
function proposal(over: Partial<Proposal> & { id: string }): Proposal {
  return {
    projectId: "p1", projectName: "Acme", kind: "mark_obsolete", material: true, summary: `Decide ${over.id}`, detail: null, itemId: null,
    patch: {}, provenance: [], status: "pending", createdAt: daysAgo(10), resolvedAt: null, ...over,
  };
}

describe("classifyNoise", () => {
  it("puts each kind of noise in its bucket with plain reasons", () => {
    const entries = classifyNoise({
      now: NOW, intelItems: [],
      meetingItems: [
        mi({ id: "over", dueDate: "2026-09-12" }),
        mi({ id: "stale", dueDate: null, meetingAt: daysAgo(35) }),
        mi({ id: "fresh", meetingAt: daysAgo(3) }),
        mi({ id: "done", status: "looks_done", suggestedStatus: "done", meetingAt: daysAgo(2) }),
        mi({ id: "ask", kind: "pain_point", meetingAt: daysAgo(31) }),
        mi({ id: "newask", kind: "suggestion", meetingAt: daysAgo(5) }),
        mi({ id: "closed", status: "dropped" }),
      ],
      proposals: [proposal({ id: "dec1", provenance: [mprov("gone-item")] }), proposal({ id: "nomeet", provenance: [] })],
    });
    expect(entries.map((e) => [e.key, e.bucket, e.kind])).toEqual([
      ["m:over", "overdue_promises", "promise"], ["m:stale", "stale_promises", "promise"], ["m:done", "looks_done", "promise"],
      ["m:ask", "old_asks", "ask"], ["p:dec1", "meeting_decisions", "decision"],
    ]);
    const over = entries[0];
    expect(over?.reasons).toEqual(["Due 12 Sep, 36 days ago", "From a meeting 5 weeks ago", "Never confirmed"]);
    expect(entries[1]?.reasons).toContain("No due date");
    expect(entries[2]?.reasons[0]).toBe("DAVE thinks this is done");
    expect(entries[4]?.meetingTitle).toBe("Acme weekly");
    expect(countByBucket(entries)).toEqual({ overdue_promises: 1, stale_promises: 1, looks_done: 1, old_asks: 1, meeting_decisions: 1 });
  });

  it("skips decisions covered by a listed meeting item", () => {
    const entries = classifyNoise({
      now: NOW, meetingItems: [mi({ id: "a", dueDate: "2026-09-01" })],
      intelItems: [intelItem({ id: "i1", provenance: [mprov("a")] })],
      proposals: [proposal({ id: "byitem", itemId: "i1", provenance: [mprov("other")] }), proposal({ id: "bysource", provenance: [mprov("a")] })],
    });
    expect(entries.map((e) => e.key)).toEqual(["m:a"]);
  });

  it("flags confirmed entries and hides them by default", () => {
    const entries = classifyNoise({
      now: NOW, proposals: [],
      meetingItems: [mi({ id: "u", dueDate: "2026-09-01", statusSource: "user" }), mi({ id: "e", dueDate: "2026-09-01", edited: true }),
        mi({ id: "l", dueDate: "2026-09-01" }), mi({ id: "plain", dueDate: "2026-09-01" })],
      intelItems: [intelItem({ id: "i1", locked: true, provenance: [mprov("l")] })],
    });
    expect(entries.filter((e) => e.confirmed).map((e) => e.key)).toEqual(["m:e", "m:l", "m:u"]);
    expect(entries.find((e) => e.key === "m:plain")?.reasons).toContain("Never confirmed");
    expect(filterEntries(entries, {}, NOW).map((e) => e.key)).toEqual(["m:plain"]);
    expect(filterEntries(entries, { includeConfirmed: true }, NOW)).toHaveLength(4);
  });

  it("is deterministic: bucket, project name, due date, key", () => {
    const items = [
      mi({ id: "z", dueDate: "2026-09-01", projectName: "Beta" }), mi({ id: "b", dueDate: "2026-09-05" }),
      mi({ id: "a", dueDate: "2026-09-05" }), mi({ id: "c", dueDate: "2026-09-02" }),
    ];
    const one = classifyNoise({ now: NOW, meetingItems: items, proposals: [], intelItems: [] });
    const two = classifyNoise({ now: NOW, meetingItems: [...items].reverse(), proposals: [], intelItems: [] });
    expect(one.map((e) => e.key)).toEqual(["m:c", "m:a", "m:b", "m:z"]);
    expect(two).toEqual(one);
  });

  it("never returns a quote", () => {
    const entries = classifyNoise({
      now: NOW, meetingItems: [mi({ id: "a", dueDate: "2026-09-01" }), mi({ id: "b", kind: "suggestion" })],
      intelItems: [intelItem({ id: "i", provenance: [mprov("a")] })], proposals: [proposal({ id: "d", provenance: [mprov("x")] })],
    });
    expect(entries.length).toBe(3);
    expect(JSON.stringify(entries)).not.toContain(SECRET);
  });
});

describe("filterEntries", () => {
  const entries = classifyNoise({
    now: NOW, intelItems: [], proposals: [proposal({ id: "dec", projectId: "p2", projectName: "Beta", provenance: [mprov("x", daysAgo(10))] })],
    meetingItems: [mi({ id: "over", dueDate: "2026-10-01", text: "Send the INVOICE" }), mi({ id: "ask", kind: "suggestion", meetingAt: daysAgo(31) })],
  });
  it("filters by bucket, kind, project, age, overdue, text and keys", () => {
    expect(filterEntries(entries, { buckets: ["old_asks"] }, NOW).map((e) => e.key)).toEqual(["m:ask"]);
    expect(filterEntries(entries, { kinds: ["decision"] }, NOW).map((e) => e.key)).toEqual(["p:dec"]);
    expect(filterEntries(entries, { projectId: "p2" }, NOW).map((e) => e.key)).toEqual(["p:dec"]);
    expect(filterEntries(entries, { olderThanDays: 30 }, NOW).map((e) => e.key)).toEqual(["m:over", "m:ask"]);
    expect(filterEntries(entries, { overdueOnly: true }, NOW).map((e) => e.key)).toEqual(["m:over"]);
    expect(filterEntries(entries, { text: "invoice" }, NOW).map((e) => e.key)).toEqual(["m:over"]);
    expect(filterEntries(entries, { text: "beta" }, NOW).map((e) => e.key)).toEqual(["p:dec"]);
    expect(filterEntries(entries, { keys: ["m:ask"] }, NOW).map((e) => e.key)).toEqual(["m:ask"]);
  });
});

describe("links", () => {
  const items = [
    intelItem({ id: "one", provenance: [mprov("a")] }),
    intelItem({ id: "two", provenance: [mprov("a"), mprov("b")] }),
    intelItem({ id: "lock", locked: true, provenance: [mprov("a")] }),
    intelItem({ id: "human", provenance: [mprov("a"), { ...mprov("a"), sourceKind: "human", sourceId: null }] }),
    intelItem({ id: "plan", provenance: [mprov("a"), { ...mprov("a"), sourceKind: "delivery-plan", sourceId: "ms1" }] }),
    intelItem({ id: "done", status: "done", provenance: [mprov("a")] }),
  ];
  it("links and decides what can close", () => {
    expect(linkedIntelItems(items, "a").map((i) => i.id)).toEqual(["one", "two", "lock", "human", "plan", "done"]);
    const closed = new Set(["a"]);
    expect(items.filter((i) => closableIntelItem(i, closed)).map((i) => i.id)).toEqual(["one"]);
    expect(items.filter((i) => closableIntelItem(i, new Set(["a", "b"]))).map((i) => i.id)).toEqual(["one", "two"]);
    const pend = [proposal({ id: "p1x", itemId: "two" }), proposal({ id: "p2x", provenance: [mprov("a")] }), proposal({ id: "p3x", itemId: "zzz" })];
    expect(linkedProposals(pend, ["two"], ["a"]).map((p) => p.id)).toEqual(["p1x", "p2x"]);
  });
});
