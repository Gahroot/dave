import { afterEach, describe, expect, it } from "vitest";
import { emptyActivity } from "../src/shared/types.ts";
import { intelHarness } from "./intel-fixture.ts";
import type { RecommendationSnapshot } from "../src/intel/ledger-types.ts";
import type { WorkEvidence } from "../src/work/types.ts";

let h: ReturnType<typeof intelHarness>;
afterEach(() => h?.close());
const pending = (kind?: string) => h.intel.store.pendingProposals().filter((p) => !kind || p.kind === kind);
const strip = (s: string) => s.replace(/"(updated_at|reconciled_at)":"[^"]*"/g, "");

describe("reconcile: idempotency and dedupe", () => {
  it("running twice with the same input changes nothing", async () => {
    h = intelHarness();
    h.addItem({ id: "m1", recordingId: "100", kind: "commitment", text: "Send the invoice export to Acme", due: "2026-10-15" });
    h.addItem({ id: "m2", recordingId: "100", kind: "suggestion", role: "client", text: "Add CSV export", feature: { title: "CSV export", outcome: "Finance can export invoices", acceptance: ["Export opens in Excel"] } });
    h.addItem({ id: "m3", recordingId: "100", kind: "decision", text: "We will use Stripe for billing" });
    await h.intel.reconcile();
    const first = h.snapshot();
    expect(JSON.parse(first).items.length).toBeGreaterThan(0);
    await h.intel.reconcile();
    await h.intel.reconcile("p1");
    expect(strip(h.snapshot())).toBe(strip(first));
  });

  it("the same commitment repeated in a later meeting adds provenance, not a duplicate", async () => {
    h = intelHarness();
    h.addItem({ id: "m1", recordingId: "100", text: "Send the invoice export to Acme", due: "2026-10-15" });
    await h.intel.reconcile();
    h.addItem({ id: "m9", recordingId: "101", text: "Send invoice export to Acme!", due: "2026-10-15" });
    await h.intel.reconcile();
    const items = h.intel.store.items("p1").filter((i) => i.kind === "commitment");
    expect(items).toHaveLength(1);
    expect(items[0]?.provenance.map((p) => p.sourceId).sort()).toEqual(["m1", "m9"]);
    expect(items[0]?.provenance[0]).toMatchObject({ sourceKind: "meeting", label: expect.stringContaining("Call 100"), link: "#meetings?rec=100" });
  });

  it("a repeated client suggestion yields one requirement proposal; rejecting it keeps it away", async () => {
    h = intelHarness();
    h.addItem({ id: "s1", recordingId: "100", kind: "suggestion", role: "client", text: "Add CSV export" });
    h.addItem({ id: "s2", recordingId: "101", kind: "pain_point", role: "client", text: "add csv exports" });
    await h.intel.reconcile();
    expect(pending("new_requirement")).toHaveLength(1);
    h.intel.resolveProposal(pending("new_requirement")[0]!.id, false, "not now");
    await h.intel.reconcile();
    expect(pending("new_requirement")).toHaveLength(0);
    expect(h.intel.store.items("p1").filter((i) => i.kind === "requirement")).toHaveLength(0);
  });
});

describe("reconcile: human authority", () => {
  it("never overwrites a locked item: a changed deadline becomes a proposal", async () => {
    h = intelHarness();
    h.addItem({ id: "m1", recordingId: "100", text: "Deliver the pilot to Acme", due: "2026-10-20" });
    await h.intel.reconcile();
    const item = h.intel.store.items("p1").find((i) => i.kind === "commitment")!;
    h.intel.patchItem(item.id, { locked: true });
    h.addItem({ id: "m2", recordingId: "102", text: "Deliver the pilot to Acme", due: "2026-10-27" });
    h.db.prepare("UPDATE meetings SET started_at='2026-10-11T10:00:00.000Z', created_at='2026-10-11T10:00:00.000Z' WHERE recording_id='102'").run();
    await h.intel.reconcile();
    const after = h.intel.store.item(item.id)!;
    expect(after.dueDate).toBe("2026-10-20");
    expect(after.locked).toBe(true);
    expect(after.basis).toBe("confirmed");
    const p = pending("deadline_change");
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ material: true, itemId: item.id });
    h.intel.resolveProposal(p[0]!.id, true, null);
    expect(h.intel.store.item(item.id)?.dueDate).toBe("2026-10-27");
  });

  it("a conflicting same-meeting date is a conflict proposal and changes nothing", async () => {
    h = intelHarness();
    h.addItem({ id: "m1", recordingId: "100", text: "Ship the portal", due: "2026-10-20" });
    h.addItem({ id: "m2", recordingId: "100", text: "Ship the portal", due: "2026-10-25" });
    await h.intel.reconcile();
    expect(pending("conflict")).toHaveLength(1);
    expect(h.intel.store.items("p1").filter((i) => i.kind === "commitment")).toHaveLength(0);
  });

  it("human edits mark items confirmed and are logged as human_edit", async () => {
    h = intelHarness();
    h.addItem({ id: "m1", recordingId: "100", kind: "decision", text: "Use Postgres" });
    await h.intel.reconcile();
    const item = h.intel.store.items("p1")[0]!;
    expect(item.basis).toBe("inferred");
    h.intel.patchItem(item.id, { title: "Use Postgres 16" });
    expect(h.intel.store.item(item.id)).toMatchObject({ basis: "confirmed", title: "Use Postgres 16" });
    expect(h.intel.store.changes("p1").some((c) => c.kind === "human_edit")).toBe(true);
  });
});

describe("reconcile: code evidence is not acceptance", () => {
  it("git evidence only reaches implementation_observed, never verified", async () => {
    const activity = { ...emptyActivity(), lastCommitAt: "2026-10-11T10:00:00.000Z", recentCommitSubjects: ["Add CSV export to invoices"] };
    h = intelHarness([{ id: "p1", name: "Acme", extra: { activity } }]);
    h.addItem({ id: "s1", recordingId: "100", kind: "suggestion", role: "client", text: "CSV export of invoices" });
    await h.intel.reconcile();
    h.intel.resolveProposal(pending("new_requirement")[0]!.id, true, null);
    await h.intel.reconcile();
    const req = h.intel.store.items("p1").find((i) => i.kind === "requirement")!;
    expect(req.evidenceState).toBe("implementation_observed");
    expect(req.status).not.toBe("done");
    expect(req.readinessReached).toBeNull();
    expect(req.provenance.some((p) => p.sourceKind === "git")).toBe(true);
    expect(h.intel.projectIntel("p1").gaps.some((g) => g.state === "unverified")).toBe(true);
  });

  it("work events link explicitly by item id, reach only implementation_observed, and the ledger hook sees the ranking", async () => {
    const work: WorkEvidence[] = [];
    const seen: RecommendationSnapshot[] = [];
    h = intelHarness(undefined, { workEvidence: (id) => (id === "p1" ? work : []), onRecommendations: (s) => { seen.push(s); throw new Error("ledger failure is ignored"); } });
    h.addItem({ id: "s1", recordingId: "100", kind: "suggestion", role: "client", text: "CSV export of invoices" });
    await h.intel.reconcile();
    h.intel.resolveProposal(pending("new_requirement")[0]!.id, true, null);
    const req = h.intel.store.items("p1").find((i) => i.kind === "requirement")!;
    expect(req.evidenceState).toBe("not_implemented");
    // The run's wording shares nothing with the title; only the explicit DAVE-Items link ties it to the item.
    work.push({ id: "we-1", kind: "agent-task", label: "EZ Coder run finished", at: "2026-10-12T08:00:00.000Z", text: "Finance download button", itemIds: [req.id] });
    await h.intel.reconcile("p1");
    const after = h.intel.store.item(req.id)!;
    expect(after.evidenceState).toBe("implementation_observed");
    expect(after.status).not.toBe("done");
    expect(after.provenance.some((p) => p.sourceKind === "agent-task" && p.sourceId === "we-1")).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toMatchObject({ trigger: "reconcile", at: "2026-10-12T09:00:00.000Z" });
    expect(seen.at(-1)?.byProject.get("p1")?.objective?.projectId).toBe("p1");
  });
});

describe("degraded sources", () => {
  it("keeps the stored plan, reports degraded health and staleness", async () => {
    h = intelHarness();
    h.addItem({ id: "m1", recordingId: "100", text: "Send the invoice export", due: "2026-10-15" });
    await h.intel.reconcile();
    const before = h.intel.store.items("p1").length;
    expect(before).toBeGreaterThan(0);
    h.state.scan = false;
    h.db.prepare("UPDATE meeting_sync_state SET key_state='invalid', last_error='bad key' WHERE id=1").run();
    h.db.exec("DELETE FROM meeting_items");
    h.setNow("2026-10-14T09:00:00.000Z");
    await h.intel.reconcile();
    expect(h.intel.store.items("p1")).toHaveLength(before);
    const focus = h.intel.focus();
    expect(focus.sources.find((s) => s.source === "git")?.state).toBe("unavailable");
    expect(focus.sources.find((s) => s.source === "fathom")?.state).not.toBe("ok");
    expect(h.intel.store.recentChanges().some((c) => c.kind === "reconcile_degraded")).toBe(true);
    h.setNow("2026-10-17T09:00:00.000Z");
    const info = h.intel.projectIntel("p1");
    expect(info.freshness).toBe("stale");
    expect(info.items).toHaveLength(before);
    expect(info.objective?.uncertain).toBeTruthy();
  });
});

describe("outcome drafting", () => {
  it("raises clarifications when evidence is thin, and an accepted outcome is confirmed but never 'accepted' stage", async () => {
    h = intelHarness();
    h.addItem({ id: "s1", recordingId: "100", kind: "suggestion", role: "client", text: "Client portal login", feature: { title: "Client portal login", outcome: "Clients log in to see invoices", acceptance: ["Login works with SSO"] } });
    await h.intel.reconcile();
    expect(pending("clarification").length).toBeGreaterThan(0);
    expect(h.intel.projectIntel("p1").outcome).toBeNull();
    h.intel.store.addProposal({ projectId: "p1", kind: "outcome_draft", material: true, summary: "x", patch: { op: "set_outcome", desiredOutcome: "Acme staff run invoices in the portal", acceptanceCriteria: ["Used by Acme"] } }, "2026-10-12T09:00:00.000Z");
    h.intel.resolveProposal(pending("outcome_draft")[0]!.id, true, null);
    const out = h.intel.projectIntel("p1").outcome!;
    expect(out).toMatchObject({ basis: "confirmed", desiredOutcome: "Acme staff run invoices in the portal" });
    expect(Object.keys(out.readiness).sort()).toEqual(["client_accepted", "code_complete", "deployed", "usable_by_client"]);
    expect(out.stage).not.toBe("accepted");
  });

  it("drafts from the delivery goal with provenance and confidence, once", async () => {
    h = intelHarness();
    h.db.prepare("INSERT INTO delivery_state(project_id,updated_at) VALUES('p1',?)").run("2026-10-12T09:00:00.000Z");
    h.db.prepare("UPDATE delivery_state SET goal_json=? WHERE project_id='p1'").run(JSON.stringify({ goal: "Acme finance team reconciles invoices without spreadsheets", intendedUser: "finance", workflow: "w", stage: "s", provider: null, model: null, consent: null }));
    await h.intel.reconcile();
    const draft = pending("outcome_draft")[0]!;
    expect(draft.patch).toMatchObject({ op: "set_outcome", confidence: "high" });
    expect(draft.provenance[0]).toMatchObject({ sourceKind: "delivery-plan" });
    await h.intel.reconcile();
    expect(pending("outcome_draft")).toHaveLength(1);
  });
});

describe("reconcile: meeting items you closed yourself", () => {
  const commitment = () => h.intel.store.items("p1").find((i) => i.kind === "commitment")!;
  const close = (id: string, status: string, source: string) =>
    h.db.prepare("UPDATE meeting_items SET status=?, status_source=? WHERE id=?").run(status, source, id);

  it("applies directly to an inferred, unlocked item and drafts no decision", async () => {
    h = intelHarness();
    h.addItem({ id: "m1", recordingId: "100", text: "Send the invoice export to Acme", due: "2026-10-15" });
    await h.intel.reconcile();
    expect(pending("new_commitment")).toHaveLength(1);
    close("m1", "dropped", "user");
    await h.intel.reconcile();
    const item = commitment();
    expect(item.status).toBe("obsolete");
    expect(item.provenance.some((p) => p.sourceKind === "human" && p.label === "Closed by you in Meetings" && p.quote === null)).toBe(true);
    expect(pending().filter((p) => p.itemId === item.id)).toHaveLength(0);
    expect(h.intel.store.proposals("p1").some((p) => p.kind === "mark_obsolete")).toBe(false);
    const rejected = h.intel.store.proposals("p1").find((p) => p.kind === "new_commitment");
    expect(rejected?.status).toBe("rejected");
    expect(h.intel.store.changes("p1").some((c) => c.summary.includes("closed by you in meetings"))).toBe(true);
  });

  it("a confirmed item still gets a proposal", async () => {
    h = intelHarness();
    h.addItem({ id: "m1", recordingId: "100", text: "Send the invoice export to Acme" });
    await h.intel.reconcile();
    h.intel.patchItem(commitment().id, { confirm: true });
    close("m1", "done", "user");
    await h.intel.reconcile();
    expect(commitment().status).toBe("open");
    expect(pending("mark_complete")).toHaveLength(1);
  });

  it("a model-closed item still gets a proposal", async () => {
    h = intelHarness();
    h.addItem({ id: "m1", recordingId: "100", text: "Send the invoice export to Acme" });
    await h.intel.reconcile();
    close("m1", "dropped", "model");
    await h.intel.reconcile();
    expect(commitment().status).toBe("open");
    expect(pending("mark_obsolete")).toHaveLength(1);
  });

  it("an item still backed by an open meeting item gets a proposal", async () => {
    h = intelHarness();
    h.addItem({ id: "m1", recordingId: "100", text: "Send the invoice export to Acme" });
    h.addItem({ id: "m2", recordingId: "101", text: "Send invoice export to Acme!" });
    await h.intel.reconcile();
    close("m1", "dropped", "user");
    await h.intel.reconcile();
    expect(commitment().status).toBe("open");
    expect(pending("mark_obsolete")).toHaveLength(1);
  });
});
