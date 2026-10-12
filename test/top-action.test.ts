import { describe, expect, it } from "vitest";
import { normalizeInbox } from "../src/ui/inbox-model.ts";
import { pickTopAction } from "../src/ui/top-action.ts";
import type { Roadmap, RoadmapGap } from "../src/model/roadmap.ts";
import type { InboxItem } from "../src/shared/types.ts";
import type { AgentOverview, AgentRun } from "../src/agents/types.ts";

const NOW = new Date("2026-10-12T12:00:00Z");
const item = (over: Partial<InboxItem>): InboxItem => ({ id: "r", projectId: "p", projectName: "P", kind: "meeting-promise", title: "P: Send docs", detail: "Send docs", nextStep: "Send the API docs", lastObservedAt: "2026-10-12T00:00:00Z", evidence: [], status: "open", createdAt: "2026-10-01", resolvedAt: null, subjectKey: null, fingerprint: null, active: true, snoozedUntil: null, seenAt: null, urgency: 70, ...over });
const run = (status: AgentRun["status"]) => ({ runs: [{ id: "a1", projectName: "P", title: "Run", status, reason: "", updatedAt: "2026-10-12T00:00:00Z" } as AgentRun] }) as AgentOverview;
const step = (kind: "send" | "review" | "waiting" | "done", state: "active" | "paused" = "active") => ({ limit: 3, entries: [{ projectId: "d", projectName: "D", state, startedAt: "2026-10-01T00:00:00Z", step: { kind, headline: "H", why: "W" } }] });

describe("pickTopAction", () => {
  it("returns null when nothing needs you, including waiting and paused work", () => {
    expect(pickTopAction([], NOW)).toBeNull();
    expect(pickTopAction(normalizeInbox([], null, step("waiting")), NOW)).toBeNull();
    expect(pickTopAction(normalizeInbox([], null, step("send", "paused")), NOW)).toBeNull();
  });
  it("ranks across sources: a blocked agent beats a promise, which beats a ready-to-send piece", () => {
    const rows = normalizeInbox([item({})], run("waiting"), step("send"));
    const top = pickTopAction(rows, NOW)!;
    expect(top.row?.key).toBe("agent:a1");
    expect(top.alsoNext).toEqual(["P – Send docs", "D – H"]);
    expect(top.done).toMatch(/approve or refuse/);
  });
  it("lets an overdue promise outrank a plain review, and explains why and what done means", () => {
    const top = pickTopAction(normalizeInbox([item({ urgency: 90 })], run("review"), null), NOW)!;
    expect(top.row?.key).toBe("request:r");
    expect(top.impact).toMatch(/client/);
    expect(top.done).toContain("Send the API docs");
  });
  it("uses age only to break ties inside a tier", () => {
    const rows = normalizeInbox([item({ id: "old", urgency: 70, lastObservedAt: "2026-10-05T00:00:00Z" }), item({ id: "new", urgency: 70 })], null, null);
    expect(pickTopAction(rows, NOW)!.row!.id).toBe("old");
    const high = normalizeInbox([item({ id: "old", urgency: 70, lastObservedAt: "2026-09-01T00:00:00Z" }), item({ id: "hi", urgency: 71 })], null, null);
    expect(pickTopAction(high, NOW)!.row!.id).toBe("hi");
  });
  it("surfaces an uncovered promise from a roadmap above routine work, and below a blocked agent", () => {
    const gap: RoadmapGap = { itemId: "g1", kind: "promise", text: "Send staging login", newSincePlan: true, meetingTitle: "Weekly", meetingAt: "2026-10-10", dueDate: null, why: "w" };
    const road: Roadmap = { projectId: "p", projectName: "Acme", finish: null, milestones: [], progress: { milestonesAccepted: 0, milestonesTotal: 0, criteriaMet: 0, criteriaTotal: 0 }, gaps: [gap], problem: null };
    const sendRows = normalizeInbox([], null, step("send"));
    const top = pickTopAction(sendRows, NOW, [road])!;
    expect(top.gap?.itemId).toBe("g1");
    expect(top.row).toBeNull();
    expect(top.project).toBe("Acme");
    expect(top.done).toMatch(/milestone or finish criterion/);
    expect(top.alsoNext).toEqual(["D – H"]);
    expect(pickTopAction(normalizeInbox([], run("waiting"), null), NOW, [road])!.row?.key).toBe("agent:a1");
  });
});
