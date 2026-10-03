import { describe, expect, it } from "vitest";
import { normalizeInbox, inboxKindLabel, inboxSourceStatus, groupInbox, inboxCounts, inboxDisplayOrder } from "../src/ui/inbox-model.ts";
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
  it("puts meeting promises and client ideas under Ready to work, with their own labels", () => {
    const promise: InboxItem = { ...request, id: "p", kind: "meeting-promise", title: "Example: Send the API docs" };
    const idea: InboxItem = { ...request, id: "i", kind: "client-idea", title: "Example: Background export" };
    expect(normalizeInbox([promise, idea], null, null).map(row => [row.key, row.category, row.reason])).toEqual([
      ["request:p", "ready", "Send the API docs"],
      ["request:i", "ready", "Background export"],
    ]);
    expect(inboxKindLabel("meeting-promise")).toBe("Promise you made in a meeting");
    expect(inboxKindLabel("client-idea")).toBe("Client idea from a meeting");
    expect(inboxKindLabel("inspection")).toBe("Inspection suggestion");
    expect(inboxKindLabel("approval-request")).toBe("Human request inferred from task text");
  });
});

describe("grouped inbox", () => {
  // Same shape as real requests: a boilerplate title tail and the specific ask in the detail.
  const ask = (id: string, project: string, detail: string, kind: InboxItem["kind"] = "approval-request"): InboxItem =>
    ({ ...request, id, projectName: project, kind, title: `${project}: an agent is waiting on you`, detail });
  it("puts identical asks under one header and keeps every row", () => {
    const rows = normalizeInbox([
      ask("a", "Alpha", "Approve publishing"), ask("b", "Beta", "Decide on export"), ask("c", "Gamma", "Approve publishing"),
    ], null, null);
    const [section] = groupInbox(rows);
    expect(section?.category).toBe("decision");
    expect(section?.count).toBe(3);
    expect(section?.clusters.map(cluster => [cluster.ask, cluster.rows.map(row => row.id)])).toEqual([
      ["Approve publishing", ["a", "c"]],
      ["Decide on export", ["b"]],
    ]);
  });
  it("orders sections decision, ready, waiting and omits empty ones", () => {
    const rows = normalizeInbox([ask("p", "Alpha", "Send docs", "meeting-promise"), ask("d", "Beta", "Decide")], null, { ...delivery, entries: [{ ...delivery.entries[0]!, state: "paused" }] });
    expect(groupInbox(rows).map(section => section.category)).toEqual(["decision", "ready", "waiting"]);
    expect(groupInbox(normalizeInbox([ask("d", "Beta", "Decide")], null, null)).map(section => section.category)).toEqual(["decision"]);
  });
  it("does not group on the shared boilerplate when the asks differ", () => {
    const rows = normalizeInbox([ask("a", "Alpha", "Approve publishing"), ask("b", "Beta", "Decide on export")], null, null);
    expect(groupInbox(rows)[0]?.clusters).toHaveLength(2);
  });
  it("never merges the same words from different sources", () => {
    const rows = normalizeInbox([ask("r", "Alpha", "Start")], null, delivery);
    expect(groupInbox(rows).flatMap(section => section.clusters).filter(cluster => cluster.ask === "Start")).toHaveLength(2);
  });
  it("pages in the order the groups render, so a cluster is never split across scattered pages", () => {
    const rows = normalizeInbox([ask("1", "A", "Approve"), ask("2", "B", "Other"), ask("3", "C", "Approve")], null, null);
    expect(inboxDisplayOrder(rows).map(row => row.id)).toEqual(["1", "3", "2"]);
    expect(inboxDisplayOrder(rows)).toHaveLength(rows.length);
  });
  it("counts each filter from real categories", () => {
    const rows = normalizeInbox([ask("p", "A", "Send", "meeting-promise"), ask("d", "B", "Decide")], agents, null);
    expect(inboxCounts(rows)).toEqual({ all: 3, decision: 2, ready: 1, waiting: 0 });
  });
});
