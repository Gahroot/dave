import { afterEach, describe, expect, it } from "vitest";
import { classifyObligation } from "../src/meetings/obligation.ts";
import { meetingCandidates } from "../src/meetings/attention.ts";
import { DEFAULT_INSTRUCTIONS, LEGACY_DEFAULT_INSTRUCTIONS_V1, PROMPT_VERSION, systemPrompt } from "../src/meetings/prompt.ts";
import { intelHarness } from "./intel-fixture.ts";

let h: ReturnType<typeof intelHarness>;
afterEach(() => h?.close());

const NOW = new Date("2026-10-12T09:00:00.000Z");
const projects = new Map([["p1", { name: "Acme", lastTechnicalActivityAt: null as string | null }]]);
const inboxRows = () => meetingCandidates(h.meetings.items({ statuses: ["open"] }), projects, NOW);
const intelItems = () => h.intel.store.items("p1").filter((i) => i.kind === "commitment");
const pendingCommitments = () => h.intel.store.proposals("p1").filter((p) => p.status === "pending" && p.kind === "new_commitment");
const changes = () => h.intel.store.changes("p1", 200).map((c) => c.summary);
const setStrength = async (id: string, s: "firm" | "tentative") => {
  expect(h.meetings.setStrength(id, s, NOW.toISOString())).toBe(true);
  await h.intel.reconcile("p1");
};

describe("hedge and pledge table", () => {
  it.each([
    ["I could have it by Friday", "firm"],
    ["we could maybe add export", "tentative"],
    ["I'll send the API docs", "firm"],
    ["It would be nice to have dark mode", "tentative"],
    ["We should probably think about SSO", "tentative"],
    ["Let me look into that", "tentative"],
    ["I will ship the fix by tomorrow", "firm"],
  ] as const)("%s → %s", (text, strength) => {
    expect(classifyObligation({ kind: "commitment", text, quote: text }).strength).toBe(strength);
  });
});

describe("prompt v2", () => {
  it("is versioned, selective, and the old default reads as the new one", () => {
    expect(PROMPT_VERSION).toBe("meetings-v2");
    expect(systemPrompt("")).toContain("cannot turn an idea into a promise".replace("cannot", "can never"));
    expect(DEFAULT_INSTRUCTIONS).not.toContain("even when said casually");
    h = intelHarness();
    h.meetings.saveProfile("user", LEGACY_DEFAULT_INSTRUCTIONS_V1, NOW.toISOString());
    expect(h.meetings.profile()).toMatchObject({ source: "default", instructions: DEFAULT_INSTRUCTIONS });
    h.meetings.saveProfile("user", "Mine", NOW.toISOString());
    expect(h.meetings.profile()).toMatchObject({ source: "user", instructions: "Mine" });
  });
});

describe("selective meetings", () => {
  it("classifies a legacy row on read", () => {
    h = intelHarness();
    h.addItem({ id: "a", recordingId: "100", text: "Maybe we could add export someday", strength: null });
    h.addItem({ id: "b", recordingId: "100", text: "I'll send the export by Friday", strength: null });
    expect(h.meetings.item("a")).toMatchObject({ strength: "tentative", strengthSource: null });
    expect(h.meetings.item("b")).toMatchObject({ strength: "firm", strengthSource: null });
  });

  it("a tentative item makes no Inbox row, follow-up candidate or plan commitment, and counts nothing", async () => {
    h = intelHarness();
    h.addItem({ id: "idea", recordingId: "100", text: "We could maybe add export", strength: "tentative" });
    await h.intel.reconcile("p1");
    expect(inboxRows()).toEqual([]);
    expect(h.meetings.followupCandidates("p1")).toEqual([]);
    expect(intelItems()).toEqual([]);
    expect(h.meetings.detail("100")?.counts.commitment).toBe(0);
  });

  it("round trip: demote obsoletes X and withdraws its proposal; promote restores the same X with one fresh proposal", async () => {
    h = intelHarness();
    h.addItem({ id: "c1", recordingId: "100", text: "Send the API docs to Acme" });
    await h.intel.reconcile("p1");
    const [x] = intelItems();
    expect(x?.status).toBe("open");
    expect(pendingCommitments()).toHaveLength(1);
    expect(inboxRows()).toHaveLength(1);

    for (let cycle = 0; cycle < 2; cycle++) {
      await setStrength("c1", "tentative");
      expect(intelItems()).toHaveLength(1);
      expect(h.intel.store.item(x!.id)?.status).toBe("obsolete");
      expect(pendingCommitments()).toHaveLength(0);
      expect(h.intel.store.proposals("p1").some((p) => p.status === "rejected" && p.kind === "new_commitment")).toBe(true);
      expect(changes()[0]).toBe("Reclassified as an idea, not a promise: Send the API docs to Acme");
      expect(inboxRows()).toEqual([]);

      await setStrength("c1", "firm");
      const items = intelItems();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ id: x!.id, status: "open", evidenceState: "not_implemented" });
      expect(items[0]?.provenance.some((p) => p.sourceKind === "human" && p.label === "Promoted to a promise by you")).toBe(true);
      expect(pendingCommitments()).toHaveLength(1);
      expect(changes()).toContain("Restored as a promise: Send the API docs to Acme");
      expect(inboxRows()).toHaveLength(1);
    }
    // Idempotent: another reconcile changes nothing.
    const before = h.snapshot();
    await h.intel.reconcile("p1");
    expect(h.snapshot()).toBe(before);
  });

  it("a locked item is left alone on demote; a clarification asks instead", async () => {
    h = intelHarness();
    h.addItem({ id: "c1", recordingId: "100", text: "Send the API docs to Acme" });
    await h.intel.reconcile("p1");
    h.intel.resolveProposal(pendingCommitments()[0]!.id, true, null);
    await setStrength("c1", "tentative");
    const x = intelItems()[0]!;
    expect(x).toMatchObject({ status: "open", locked: true, basis: "confirmed" });
    const clar = h.intel.store.proposals("p1").filter((p) => p.kind === "clarification" && p.status === "pending" && p.itemId === x.id);
    expect(clar).toHaveLength(1);
    expect(clar[0]?.detail).toBe("A meeting now reads this as an idea; keep it as a commitment?");
    await h.intel.reconcile("p1");
    expect(h.intel.store.proposals("p1").filter((p) => p.kind === "clarification" && p.itemId === x.id)).toHaveLength(1);
  });

  it("a promise you dropped stays closed when promoted; one 'Confirm commitment again' reopens it confirmed and locked", async () => {
    h = intelHarness();
    h.addItem({ id: "c1", recordingId: "100", text: "Send the API docs to Acme" });
    await h.intel.reconcile("p1");
    const x = intelItems()[0]!;
    h.setNow("2026-10-12T09:01:00.000Z");
    h.meetings.setItemStatus("c1", { status: "dropped", source: "user", note: null }, "2026-10-12T09:01:00.000Z");
    await h.intel.reconcile("p1");
    expect(h.intel.store.item(x.id)?.status).toBe("obsolete");

    h.setNow("2026-10-12T09:02:00.000Z");
    h.meetings.setStrength("c1", "tentative", "2026-10-12T09:02:00.000Z");
    await h.intel.reconcile("p1");
    h.setNow("2026-10-12T09:03:00.000Z");
    h.meetings.setStrength("c1", "firm", "2026-10-12T09:03:00.000Z");
    await h.intel.reconcile("p1");
    await h.intel.reconcile("p1");
    expect(h.intel.store.item(x.id)?.status).toBe("obsolete");
    const again = h.intel.store.proposals("p1").filter((p) => p.status === "pending" && p.summary === "Confirm commitment again: Send the API docs to Acme");
    expect(again).toHaveLength(1);
    h.intel.resolveProposal(again[0]!.id, true, null);
    expect(h.intel.store.item(x.id)).toMatchObject({ status: "open", basis: "confirmed", locked: true });
  });
});
