import { describe, expect, it } from "vitest";
import { normalizeInbox, inboxSourceStatus } from "../src/ui/inbox-model.ts";
import type { InboxItem } from "../src/shared/types.ts";
import type { AgentOverview, AgentRun } from "../src/agents/types.ts";
const request: InboxItem = { id: "same", projectId: "example", projectName: "Example", kind: "approval-request", title: "Decide", detail: "Approval needed", nextStep: "Review", lastObservedAt: null, evidence: [], status: "open", createdAt: "2026-09-22", resolvedAt: null, subjectKey: null, fingerprint: null, active: true, snoozedUntil: null, seenAt: null, urgency: 1 };
const agent = { id: "same", projectName: "Example", title: "Run", status: "review", reason: "", updatedAt: "2026-09-22" } as AgentRun;
const agents = { runs: [agent] } as AgentOverview;
const delivery = { limit: 3, entries: [{ projectId: "same", projectName: "Example", state: "active" as const, startedAt: "2026-09-21", step: { kind: "send" as const, headline: "Start", why: "Ready" } }] };
describe("unified inbox", () => {
  it("preserves source-specific identity and deduplicates only typed IDs", () => {
    const rows = normalizeInbox([request, request], agents, delivery);
    expect(rows.map(row => row.key)).toEqual(["agent:same", "delivery:same", "request:same"]);
    expect(rows.find(row => row.source === "request")?.value).toBe(request);
  });
  it("retains working sources when another source fails", () => {
    expect(normalizeInbox([request], null, delivery)).toHaveLength(2);
    expect(inboxSourceStatus(null, delivery, { agents: "Failed", delivery: "" })).toMatchObject({ unavailable: ["agents"], deliveryCount: 1, agentCount: 0 });
  });
  it("labels capped counts rather than claiming complete coverage", () => {
    expect(inboxSourceStatus({ runs: Array(200).fill(agent) } as AgentOverview, null, { agents: "", delivery: "" }).agentsCapped).toBe(true);
    expect(inboxSourceStatus(agents, null, { agents: "", delivery: "" }).agentsCapped).toBe(false);
  });
  it("uses real state to classify attention, ready and waiting", () => {
    expect(normalizeInbox([request], agents, delivery).map(row => row.category)).toEqual(["decision", "ready", "decision"]);
    expect(normalizeInbox([], null, { ...delivery, entries: [{ ...delivery.entries[0]!, state: "paused" }] })[0]?.category).toBe("waiting");
  });
});
