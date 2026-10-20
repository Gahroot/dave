import { describe, expect, it } from "vitest";
import type { MeetingItem, MeetingsState, SyncRun } from "../src/meetings/types.ts";
import { IDEA_KIND_LABELS, connectionSummary, groupPromises, promiseGroup, runSummary, shortDay, timestamp } from "../src/ui/meetings-model.ts";

const NOW = new Date(2026, 8, 30, 12, 0, 0);
const item = (over: Partial<MeetingItem>): MeetingItem => ({
  id: "mi-1", recordingId: "1", kind: "commitment", text: "t", quote: "q", atSeconds: 0, speaker: "Dave", speakerRole: "me",
  projectId: "p1", projectName: "Acme", projectSource: "model", duePhrase: null, dueDate: null, feature: null, status: "open",
  suggestedStatus: null, statusSource: "model", statusNote: null, statusChangedAt: null, edited: false, agentRunId: null, strength: "firm", strengthSource: null, deliverable: null,
  createdAt: "", updatedAt: "", meetingTitle: "Weekly", meetingAt: "2026-09-28T16:00:00.000Z", meetingUrl: null, ...over,
});

describe("meetings page model", () => {
  it("shows a date-only due date as that local day, not the UTC-midnight day before", () => {
    expect(shortDay("2026-10-21")).toBe(new Date(2026, 9, 21).toLocaleDateString([], { month: "short", day: "numeric" }));
    expect(shortDay("not a date")).toBe("");
  });

  it("never labels an idea as a promise or an agreed decision", () => {
    for (const label of Object.values(IDEA_KIND_LABELS)) expect(label).not.toMatch(/promise|decision/i);
  });

  it.each([
    [{ dueDate: "2026-09-29" }, "overdue"],
    [{ dueDate: "2026-09-30" }, "due_soon"],
    [{ dueDate: "2026-10-02" }, "due_soon"],
    [{ dueDate: "2026-10-03" }, "open"],
    [{ dueDate: null }, "open"],
    [{ dueDate: "2026-09-01", status: "looks_done" as const }, "looks_done"],
  ])("groups %j as %s", (over, group) => {
    expect(promiseGroup(item(over), NOW)).toBe(group);
  });

  it("orders groups and sorts by due date, then newest meeting", () => {
    const groups = groupPromises([
      item({ id: "a", dueDate: "2026-10-20" }),
      item({ id: "b", dueDate: "2026-09-01" }),
      item({ id: "c", dueDate: null, meetingAt: "2026-09-29T00:00:00.000Z" }),
      item({ id: "d", status: "looks_done" }),
      item({ id: "e", dueDate: "2026-10-05" }),
    ], NOW);
    expect(groups.map(g => [g.id, g.items.map(i => i.id)])).toEqual([
      ["overdue", ["b"]],
      ["open", ["e", "a", "c"]],
      ["looks_done", ["d"]],
    ]);
  });

  it("formats timestamps like a video player", () => {
    expect(timestamp(95)).toBe("1:35");
    expect(timestamp(3723)).toBe("1:02:03");
    expect(timestamp(-5)).toBe("0:00");
  });

  it("summarizes a sync run in plain words", () => {
    const run = (over: Partial<SyncRun>): SyncRun => ({ id: 1, trigger: "schedule", outcome: "ok", stats: {}, error: null, startedAt: "", finishedAt: "", ...over });
    expect(runSummary(run({ stats: { added: 2, transcripts: 1, skipped: 1 } }))).toBe("Finished: 2 new, 1 transcript, 1 skipped");
    expect(runSummary(run({}))).toBe("Finished: nothing new");
    expect(runSummary(run({ outcome: "error", error: "Could not reach Fathom" }))).toBe("Failed. Could not reach Fathom");
  });

  it("describes the connection state the owner is in", () => {
    const base: MeetingsState = {
      key: { saved: true, state: "valid", storageError: false },
      settings: { fathomEmail: "dave@studio.dev", nameAliases: [], historyDays: 30, paused: false, ignoreWords: [], autoExtract: false, consentVersion: null, consentAt: null, connectedAt: "2026-09-30T00:00:00.000Z", updatedAt: "" },
      sync: { keyState: "valid", lastSuccessAt: null, backoffUntil: null, failures: 0, lastError: null, lastRunAt: null, followupAt: null, running: false, intervalMs: 300000 },
      runs: [],
      analysis: { disclosure: { title: "", sections: [], notes: [], version: "v" }, on: false, consentOutdated: false, openAIConnected: false, running: null, queued: [] },
    };
    expect(connectionSummary(base)).toBe("Connected. DAVE checks Fathom every 5 minutes.");
    expect(connectionSummary({ ...base, key: { ...base.key, saved: false } })).toBe("Not connected.");
    expect(connectionSummary({ ...base, key: { ...base.key, state: "invalid" } })).toBe("Fathom rejected the saved key.");
    expect(connectionSummary({ ...base, key: { ...base.key, storageError: true } })).toContain("Keychain is not available");
    expect(connectionSummary({ ...base, settings: { ...base.settings, fathomEmail: "" } })).toContain("Enter your Fathom email");
    expect(connectionSummary({ ...base, settings: { ...base.settings, paused: true } })).toContain("paused");
  });
});
