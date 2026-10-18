import { describe, expect, it } from "vitest";
import type { TriageBatch, TriageBucket, TriageEntry, TriageKind, TriageResult } from "../src/triage/types.ts";
import { batchLine, bucketState, canMarkDone, defaultSelection, groupByBucket, projectOptions, pruneSelection, resultText, summarySentence, toggleBucket, toggleOne, undoText } from "../src/ui/cleanup-model.ts";

const entry = (key: string, bucket: TriageBucket, kind: TriageKind = "promise", confirmed = false, project: string | null = null): TriageEntry =>
  ({ key, kind, bucket, title: key, projectId: project, projectName: project ? `P ${project}` : null, dueDate: null, meetingAt: null, meetingTitle: null, reasons: [], confirmed });
const counts = (c: Partial<Record<TriageBucket, number>>): Record<TriageBucket, number> =>
  ({ overdue_promises: 0, stale_promises: 0, looks_done: 0, old_asks: 0, meeting_decisions: 0, ...c });
const result = (r: Partial<TriageResult>): TriageResult => ({ batchId: "tb-1", changed: 0, skipped: [], kept: [], summary: "", ...r });

describe("cleanup model", () => {
  it("groups in bucket order and drops empty buckets", () => {
    const groups = groupByBucket([entry("a", "meeting_decisions", "decision"), entry("b", "overdue_promises"), entry("c", "old_asks", "ask"), entry("d", "overdue_promises")]);
    expect(groups.map(g => g.bucket)).toEqual(["overdue_promises", "old_asks", "meeting_decisions"]);
    expect(groups[0]?.entries.map(e => e.key)).toEqual(["b", "d"]);
  });

  it("never preselects confirmed rows and can limit to one bucket", () => {
    const entries = [entry("a", "overdue_promises"), entry("b", "overdue_promises", "promise", true), entry("c", "old_asks", "ask")];
    expect([...defaultSelection(entries)]).toEqual(["a", "c"]);
    expect([...defaultSelection(entries, "old_asks")]).toEqual(["c"]);
    expect([...defaultSelection(entries, "looks_done")]).toEqual([]);
  });

  it("toggles one and bucket with tri-state", () => {
    const bucket = [entry("a", "old_asks", "ask"), entry("b", "old_asks", "ask")];
    let sel = new Set<string>();
    expect(bucketState(sel, bucket)).toBe("none");
    sel = toggleOne(sel, "a");
    expect(bucketState(sel, bucket)).toBe("some");
    sel = toggleBucket(sel, bucket);
    expect(bucketState(sel, bucket)).toBe("all");
    sel = toggleBucket(sel, bucket);
    expect(bucketState(sel, bucket)).toBe("none");
    expect(toggleOne(toggleOne(sel, "x"), "x").size).toBe(0);
    expect([...pruneSelection(new Set(["a", "gone"]), bucket)]).toEqual(["a"]);
  });

  it("allows Mark done only for promises and looks-done entries", () => {
    expect(canMarkDone([])).toBe(false);
    expect(canMarkDone([entry("a", "overdue_promises"), entry("b", "looks_done", "ask")])).toBe(true);
    expect(canMarkDone([entry("a", "overdue_promises"), entry("c", "old_asks", "ask")])).toBe(false);
    expect(canMarkDone([entry("d", "meeting_decisions", "decision")])).toBe(false);
  });

  it("writes the summary with plurals and an empty case", () => {
    expect(summarySentence(counts({}), 0)).toBe("Nothing looks like noise right now.");
    expect(summarySentence(counts({ overdue_promises: 41, stale_promises: 12, old_asks: 20 }), 73))
      .toBe("DAVE found 73 items that look like noise: 41 overdue promises nobody confirmed, 12 old promises with no date and 20 old client asks.");
    expect(summarySentence(counts({ looks_done: 1 }), 1)).toBe("DAVE found 1 item that looks like noise: 1 item that looks done.");
  });

  it("describes results with kept and skipped notes", () => {
    expect(resultText(result({ changed: 41 }), "clear")).toBe("Cleared 41 items.");
    expect(resultText(result({ changed: 1 }), "done")).toBe("Marked 1 item done.");
    expect(resultText(result({ batchId: null, changed: 0, skipped: [{ key: "m:1", reason: "already gone" }] }), "clear")).toBe("Nothing was changed. 1 item was left alone (already gone).");
    expect(resultText(result({ changed: 3, skipped: [{ key: "a", reason: "locked" }, { key: "b", reason: "gone" }], kept: [{ key: "c", reason: "locked" }] }), "clear"))
      .toBe("Cleared 3 items. 2 items were left alone (gone; locked). Kept 1 linked record on purpose, such as a plan item you locked.");
    expect(undoText(2, 0)).toBe("Restored 2 items.");
    expect(undoText(0, 1)).toBe("Nothing needed restoring. 1 item was left as is because it changed since.");
    expect(undoText(3, 2)).toBe("Restored 3 items. 2 items were left as is because they changed since.");
  });

  it("formats batch lines deterministically and lists projects sorted", () => {
    const batch: TriageBatch = { id: "tb-1", createdAt: "2026-10-18T13:05:00Z", source: "voice", action: "clear", summary: "Cleared 4 items.", count: 4, undoneAt: null };
    expect(batchLine(batch, "UTC")).toBe("Cleared 4 items · 18 Oct, 13:05 · from voice");
    expect(projectOptions([entry("a", "old_asks", "ask", false, "z"), entry("b", "old_asks", "ask", false, "a"), entry("c", "old_asks", "ask", false, "z"), entry("d", "old_asks")]))
      .toEqual([{ value: "a", label: "P a" }, { value: "z", label: "P z" }]);
  });
});
