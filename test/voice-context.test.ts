import { afterEach, describe, expect, it } from "vitest";
import { intelHarness } from "./intel-fixture.ts";
import { alignmentGaps, CONTEXT_MAX_CHARS, voiceContext } from "../src/voice/context.ts";
import type { VoiceIntel } from "../src/voice/deps.ts";
import type { DirectionApi, DirectionNote } from "../src/intel/types.ts";

const hs: ReturnType<typeof intelHarness>[] = [];
afterEach(() => { for (const h of hs.splice(0)) h.close(); });

const base = { projectName: "Acme", hasFinishLine: true, paidWhen: "sign-off", targetDate: "2026-11-01", focusItems: [], topObjectiveTargets: null, freshness: "fresh" as const };

describe("alignmentGaps", () => {
  it("is empty when aligned", () => { expect(alignmentGaps(base)).toEqual([]); });
  it("lists each gap", () => {
    expect(alignmentGaps({ ...base, hasFinishLine: false, paidWhen: null, freshness: "never" })).toEqual(["Acme has no finish line yet.", 'Acme has no "paid when" yet.', "Acme was never checked by DAVE."]);
    expect(alignmentGaps({ ...base, targetDate: null })).toEqual(["Acme has no target date."]);
    const g = alignmentGaps({ ...base, focusItems: [{ id: "i1", title: "Reports", lane: "phase2" }], topObjectiveTargets: ["i2"], freshness: "stale" });
    expect(g).toHaveLength(3);
    expect(g[0]).toContain("phase 2");
    expect(g[1]).toContain("top pick");
  });
});

describe("voiceContext", () => {
  it("is bounded, speakable and has no quotes", () => {
    const h = intelHarness(Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `Project ${i} https://example.com/x` })));
    hs.push(h);
    for (let i = 0; i < 12; i++) h.intel.putOutcome(`p${i}`, { desiredOutcome: `Client ${i} ${"does a long thing ".repeat(30)}`, acceptanceCriteria: [] });
    h.addItem({ id: "mi-1", recordingId: "1", text: "Send invoice", quote: "VERBATIM QUOTE TEXT", due: "2026-10-01", project: "p1" });
    const notes: DirectionNote[] = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, projectId: "p1", text: `note ${i} ${"x ".repeat(200)} /Users/me/secret/a.txt`, source: "voice", createdAt: "2026-10-10T00:00:00.000Z" }));
    const fake: DirectionApi = { direction: (id) => ({ projectId: id, paidWhen: null, priority: null, focusItemIds: [], notes: [], updatedAt: null }), setDirection: () => { throw new Error("no"); }, addDirectionNote: () => { throw new Error("no"); }, deleteDirectionNote: () => undefined, directionNotes: () => notes };
    const intel: VoiceIntel = { ...h.intel, ...fake };
    const text = voiceContext({ intel, lastSummary: () => "Talked about Acme.", projectName: (id) => `Project ${id}` }, { route: "#focus?project=p1", projectId: "p1" }, new Date("2026-10-12T09:00:00Z"));
    expect(text.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
    expect(text).toContain("Today is 2026-10-12");
    expect(text).not.toContain("https://");
    expect(text).not.toContain("/Users/me");
    expect(text).not.toContain("VERBATIM QUOTE");
    expect(text).toContain("paid when");
  });
});
