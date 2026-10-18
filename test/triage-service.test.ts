import { afterEach, describe, expect, it } from "vitest";
import { createTriageService } from "../src/triage/service.ts";
import { reconcileProject } from "../src/intel/reconcile.ts";
import { intelHarness } from "./intel-fixture.ts";

let h: ReturnType<typeof intelHarness>;
afterEach(() => h?.close());

function setup(now = "2026-10-12T09:00:00.000Z") {
  h = intelHarness();
  let changed = 0;
  let clock = new Date(now);
  const triage = createTriageService({ db: h.db, now: () => clock, projectName: () => "Acme", onChanged: () => { changed++; } });
  return { triage, changed: () => changed, setNow: (iso: string) => { clock = new Date(iso); } };
}
const meeting = (id: string) => h.db.prepare("SELECT status, status_source, status_note FROM meeting_items WHERE id=?").get(id) as Record<string, unknown>;
const commitment = () => h.intel.store.items("p1").find((i) => i.kind === "commitment");
const proposalsFor = (itemId: string) => h.intel.store.proposals("p1").filter((p) => p.itemId === itemId);

describe("triage apply", () => {
  it("clears a promise everywhere in one batch, and undo puts it all back", async () => {
    const t = setup();
    h.addItem({ id: "m1", recordingId: "100", text: "Send the invoice export to Acme", due: "2026-10-01" });
    await h.intel.reconcile();
    const item = commitment();
    expect(item?.status).toBe("open");
    const preview = t.triage.preview();
    expect(preview.entries.map((e) => e.key)).toEqual(["m:m1"]);
    expect(preview.counts.overdue_promises).toBe(1);

    const res = t.triage.apply({ keys: ["m:m1"], action: "clear", source: "ui" });
    expect(res).toMatchObject({ changed: 1, skipped: [], kept: [], summary: "Cleared 1 item." });
    expect(res.batchId).toMatch(/^tb-[0-9a-f]{24}$/);
    expect(meeting("m1")).toMatchObject({ status: "dropped", status_source: "user", status_note: "Cleared in clean-up" });
    expect(h.intel.store.item(item?.id ?? "")?.status).toBe("dropped");
    expect(proposalsFor(item?.id ?? "").map((p) => p.status)).toEqual(["rejected"]);
    expect(h.intel.store.changes("p1").some((c) => c.summary === "Cleared 1 item in clean-up")).toBe(true);
    expect(t.changed()).toBe(1);
    expect(t.triage.preview().total).toBe(0);

    // A later reconcile drafts nothing new for the cleared item.
    reconcileProject(h.intel.store, { projectId: "p1", projectName: "Acme", goal: null, summary: null, commits: [], tasks: [],
      meetingItems: h.meetings.items({}), meetings: [], milestones: [], sources: [] }, new Date("2026-10-12T10:00:00.000Z"));
    expect(proposalsFor(item?.id ?? "").map((p) => p.status)).toEqual(["rejected"]);
    await h.intel.reconcile();
    expect(h.intel.store.pendingProposals().filter((p) => p.itemId === item?.id)).toHaveLength(0);

    const batches = t.triage.batches();
    expect(batches).toEqual([expect.objectContaining({ id: res.batchId, action: "clear", source: "ui", count: 1, undoneAt: null })]);
    expect(t.triage.undo(res.batchId ?? "")).toEqual({ restored: 3, skipped: 0 });
    expect(meeting("m1")).toMatchObject({ status: "open", status_source: "model", status_note: null });
    expect(h.intel.store.item(item?.id ?? "")?.status).toBe("open");
    expect(proposalsFor(item?.id ?? "")[0]).toMatchObject({ status: "pending", resolvedAt: null });
    expect(t.triage.batches()[0]?.undoneAt).not.toBeNull();
    expect(t.triage.undo(res.batchId ?? "")).toEqual({ restored: 0, skipped: 0 });
    expect(t.triage.undo("tb-000000000000000000000000")).toBeNull();
  });

  it("keeps a locked plan item and reports it", async () => {
    const t = setup();
    h.addItem({ id: "m1", recordingId: "100", text: "Send the invoice export to Acme", due: "2026-10-01" });
    await h.intel.reconcile();
    const id = commitment()?.id ?? "";
    h.intel.patchItem(id, { locked: true });
    const res = t.triage.apply({ keys: ["m:m1"], action: "clear", source: "ui" });
    expect(res.kept).toEqual([{ key: "m:m1", reason: "Plan item you locked" }]);
    expect(meeting("m1")).toMatchObject({ status: "dropped" });
    expect(h.intel.store.item(id)?.status).toBe("open");
  });

  it("keeps a plan item you confirmed (not locked) and reports it", async () => {
    const t = setup();
    h.addItem({ id: "m1", recordingId: "100", text: "Send the invoice export to Acme", due: "2026-10-01" });
    await h.intel.reconcile();
    const id = commitment()?.id ?? "";
    h.intel.patchItem(id, { confirm: true });
    expect(h.intel.store.item(id)).toMatchObject({ basis: "confirmed", locked: false });
    expect(t.triage.preview().entries).toHaveLength(0);
    expect(t.triage.preview({ includeConfirmed: true }).entries.map((e) => [e.key, e.confirmed])).toEqual([["m:m1", true]]);
    const res = t.triage.apply({ keys: ["m:m1"], action: "clear", source: "ui" });
    expect(res.kept).toEqual([{ key: "m:m1", reason: "Plan item you confirmed" }]);
    expect(h.intel.store.item(id)?.status).toBe("open");
  });

  it("a plan item backed by two meetings closes only when both are cleared", async () => {
    const t = setup();
    h.addItem({ id: "m1", recordingId: "100", text: "Send the invoice export to Acme", due: "2026-10-01" });
    h.addItem({ id: "m2", recordingId: "101", text: "Send invoice export to Acme!", due: "2026-10-01" });
    await h.intel.reconcile();
    const id = commitment()?.id ?? "";
    const first = t.triage.apply({ keys: ["m:m1"], action: "clear", source: "ui" });
    expect(first.kept).toEqual([{ key: "m:m1", reason: "Still backed by another meeting" }]);
    expect(h.intel.store.item(id)?.status).toBe("open");
    t.triage.apply({ keys: ["m:m2"], action: "clear", source: "ui" });
    expect(h.intel.store.item(id)?.status).toBe("dropped");
  });

  it("marks done only promises and looks-done items, and skips gone keys", async () => {
    const t = setup("2026-11-20T09:00:00.000Z");
    h.addItem({ id: "m1", recordingId: "100", text: "Send the invoice export to Acme" });
    h.addItem({ id: "s1", recordingId: "100", kind: "suggestion", role: "client", text: "Add CSV export" });
    const res = t.triage.apply({ keys: ["m:m1", "m:s1", "m:mi-000000000000000000000000", "m:m1"], action: "done", source: "voice" });
    expect(res.changed).toBe(1);
    expect(res.summary).toBe("Marked 1 item done.");
    expect(res.skipped).toEqual([
      { key: "m:s1", reason: "Only promises and looks-done items can be marked done" },
      { key: "m:mi-000000000000000000000000", reason: "gone" },
    ]);
    expect(meeting("m1")).toMatchObject({ status: "done", status_note: "Marked done in clean-up" });
    expect(meeting("s1")).toMatchObject({ status: "open" });
    const none = t.triage.apply({ keys: ["m:m1"], action: "clear", source: "ui" });
    expect(none).toMatchObject({ batchId: null, changed: 0, skipped: [{ key: "m:m1", reason: "gone" }] });
  });

  it("undo leaves rows you changed since alone", async () => {
    const t = setup();
    h.addItem({ id: "m1", recordingId: "100", text: "Send the invoice export", due: "2026-10-01" });
    h.addItem({ id: "m2", recordingId: "100", text: "Book the demo room", due: "2026-10-02" });
    const res = t.triage.apply({ keys: ["m:m1", "m:m2"], action: "clear", source: "ui" });
    expect(res.changed).toBe(2);
    h.meetings.setItemStatus("m2", { status: "done", source: "user", note: "Did it" }, "2026-10-12T10:00:00.000Z");
    expect(t.triage.undo(res.batchId ?? "")).toEqual({ restored: 1, skipped: 1 });
    expect(meeting("m1")).toMatchObject({ status: "open" });
    expect(meeting("m2")).toMatchObject({ status: "done", status_note: "Did it" });
  });

  it("re-analysis keeps a cleared item dropped", () => {
    const t = setup();
    h.addItem({ id: "m1", recordingId: "100", text: "Send the invoice export", due: "2026-10-01" });
    t.triage.apply({ keys: ["m:m1"], action: "clear", source: "ui" });
    // The same upsert shape as src/meetings/extract.ts re-analysis: status is never in the update set.
    h.db.prepare(`INSERT INTO meeting_items(id, recording_id, kind, text, quote, at_seconds, speaker, speaker_role, project_id, due_date, status, status_source, created_at, updated_at)
      VALUES ('m1','100','commitment','Send the invoice export again','q',5,'Me','me','p1','2026-10-01','open','model',?,?)
      ON CONFLICT(id) DO UPDATE SET quote = excluded.quote, text = CASE WHEN meeting_items.edited = 1 THEN meeting_items.text ELSE excluded.text END,
        due_date = CASE WHEN meeting_items.edited = 1 THEN meeting_items.due_date ELSE excluded.due_date END, updated_at = excluded.updated_at`)
      .run("2026-10-13T00:00:00.000Z", "2026-10-13T00:00:00.000Z");
    expect(meeting("m1")).toMatchObject({ status: "dropped", status_source: "user" });
    expect(t.triage.preview().total).toBe(0);
  });
});

describe("triage decisions", () => {
  it("accepts a drop decision whose meeting you already closed", async () => {
    const t = setup();
    h.addItem({ id: "m1", recordingId: "100", text: "Send the invoice export to Acme" });
    await h.intel.reconcile();
    h.db.prepare("UPDATE meeting_items SET status='dropped', status_source='model' WHERE id='m1'").run();
    await h.intel.reconcile();
    const drop = h.intel.store.pendingProposals().find((p) => p.kind === "mark_obsolete");
    expect(drop).toBeTruthy();
    const entry = t.triage.preview({ includeConfirmed: true }).entries.find((e) => e.key === `p:${drop?.id}`);
    expect(entry).toMatchObject({ kind: "decision", bucket: "meeting_decisions" });
    t.triage.apply({ keys: [`p:${drop?.id}`], action: "clear", source: "ui" });
    expect(h.intel.store.proposal(drop?.id ?? "")?.status).toBe("accepted");
    expect(commitment()?.status).toBe("obsolete");
  });

  it("rejecting a commitment decision drops its inferred item and its open promise", async () => {
    const t = setup();
    h.addItem({ id: "m1", recordingId: "100", text: "Send the invoice export to Acme" });
    await h.intel.reconcile();
    const confirm = h.intel.store.pendingProposals().find((p) => p.kind === "new_commitment");
    const res = t.triage.apply({ keys: [`p:${confirm?.id}`], action: "clear", source: "ui" });
    expect(res.changed).toBe(1);
    expect(h.intel.store.proposal(confirm?.id ?? "")?.status).toBe("rejected");
    expect(commitment()?.status).toBe("dropped");
    expect(meeting("m1")).toMatchObject({ status: "dropped", status_source: "user", status_note: "Cleared in clean-up" });
    const done = t.triage.apply({ keys: [`p:${confirm?.id}`], action: "done", source: "ui" });
    expect(done.skipped).toEqual([{ key: `p:${confirm?.id}`, reason: "gone" }]);
  });
});
