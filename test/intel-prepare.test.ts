import { fakeLedger, fakeMeetings, NOW, report } from "./intel-prepare-fixture.ts";
import { afterEach, describe, expect, it } from "vitest";
import { intelHarness } from "./intel-fixture.ts";
import { prepareActions, type PromiseInput } from "../src/intel/prepare.ts";
import { createNextService, NextError } from "../src/intel/next.ts";
import type { ProgressReport } from "../src/work/types.ts";
import type { PreparedAction } from "../src/intel/next-types.ts";
import type { MeetingItem } from "../src/meetings/types.ts";

type H = ReturnType<typeof intelHarness>;
const hs: H[] = [];
afterEach(() => { for (const h of hs.splice(0)) h.close(); });

function harness(): H { const h = intelHarness(); hs.push(h); return h; }

function prep(h: H, progress: ProgressReport[] = [], promises: PromiseInput[] = []): PreparedAction[] {
  const focus = h.intel.focus();
  const projects = focus.projects.map((p) => h.intel.projectIntel(p.projectId));
  return prepareActions({ now: new Date(NOW), focus, projects, promises, progress });
}
const ofKind = (as: PreparedAction[], kind: PreparedAction["kind"]) => as.filter((a) => a.kind === kind);

/** Confirmed finish line with two requirements; returns their ids. */
function confirmed(h: H): string[] {
  h.intel.putOutcome("p1", { desiredOutcome: "Acme staff book online", acceptanceCriteria: ["Works on a phone"] });
  const r = h.intel.addFinishLineItems("p1", [{ title: "Online booking form", acceptance: ["A patient can book a free slot"] }, { title: "Staff calendar view" }]);
  return r.intel.items.filter((i) => i.kind === "requirement").map((i) => i.id);
}

describe("prepareActions mapping", () => {
  it("confirm_finish_line when nothing is confirmed", () => {
    const h = harness();
    h.intel.addItem("p1", { kind: "requirement", title: "Export to CSV" });
    const a = ofKind(prep(h), "confirm_finish_line")[0];
    expect(a).toBeDefined();
    expect(a?.draft?.kind).toBe("checklist");
    expect(a?.secondary.map((s) => s.op.op)).toEqual(expect.arrayContaining(["skip", "defer"]));
  });

  it("build: a coding objective is a hand-off with a brief", () => {
    const h = harness();
    confirmed(h);
    const a = ofKind(prep(h), "build")[0];
    expect(a?.effort).toBe("hand_off");
    expect(a?.primary.op.op).toBe("hand_to_ezcoder");
    expect(a?.draft?.kind).toBe("brief");
    expect(a?.draft?.text.length).toBeGreaterThan(10);
    expect(a?.id).toMatch(/^[a-f0-9]{16}$/);
  });

  it("target_date: one tap with the suggested date or a pick", () => {
    const h = harness();
    confirmed(h);
    const a = ofKind(prep(h), "target_date")[0];
    expect(a?.primary.op.op).toBe("set_target_date");
  });

  it("verify: moved progress with unverified items gives a checklist, copy and Mark verified", () => {
    const h = harness();
    const [r1] = confirmed(h);
    const rep = report({ eventId: "e1", at: "2026-10-12T08:00:00.000Z", advanced: [{ itemId: r1 ?? "", title: "Online booking form", from: { status: "open", evidenceState: "not_implemented" }, to: { status: "open", evidenceState: "implementation_observed" } }] });
    const a = ofKind(prep(h, [rep]), "verify")[0];
    expect(a?.primary.op).toEqual({ op: "copy" });
    expect(a?.draft?.kind).toBe("checklist");
    expect(a?.draft?.text).toContain("[ ] A patient can book a free slot");
    expect(a?.secondary[0]?.op).toEqual({ op: "mark_verified", itemId: r1 });
    const old = ofKind(prep(h, [{ ...rep, at: "2026-10-05T08:00:00.000Z" }]), "verify")[0];
    expect((a?.score ?? 0) - (old?.score ?? 0)).toBe(20);
  });

  it("retry: a failed run gives a brief with the failure summary", () => {
    const h = harness();
    confirmed(h);
    const a = ofKind(prep(h, [report({ eventId: "e2", at: "2026-10-12T08:00:00.000Z", verdict: "failed", headline: "EZ Coder run failed: tests broke" })]), "retry")[0];
    expect(a?.draft?.kind).toBe("brief");
    expect(a?.draft?.text).toContain("tests broke");
  });

  it("decide: same-kind proposals batch into one accept_proposals; conflicts stay single with a review answer", () => {
    const h = harness();
    confirmed(h);
    const s = h.intel.store;
    s.addProposal({ projectId: "p1", kind: "new_requirement", material: true, summary: "Add SMS reminders" }, NOW);
    s.addProposal({ projectId: "p1", kind: "new_requirement", material: true, summary: "Add a waiting list" }, NOW);
    s.addProposal({ projectId: "p1", kind: "conflict", material: true, summary: "Two dates for launch" }, NOW);
    const ds = ofKind(prep(h), "decide");
    const batch = ds.find((a) => a.primary.op.op === "accept_proposals");
    expect(batch?.primary.op.op === "accept_proposals" && batch.primary.op.proposalIds.length).toBe(2);
    expect(batch?.draft?.text).toMatch(/Recommended: accept/);
    const conflict = ds.find((a) => a.primary.op.op === "accept_proposal");
    expect(conflict?.whyNow).toMatch(/look at it first/);
    expect((batch?.score ?? 0) - (conflict?.score ?? 0)).toBe(10);
  });

  it("chase: a client blocker gets a message naming the thing, what it blocks and the wait", () => {
    const h = harness();
    confirmed(h);
    h.setNow("2026-10-02T09:00:00.000Z");
    const pi = h.intel.addItem("p1", { kind: "blocker", title: "Staging API key", owner: "client" });
    const blocker = pi.items.find((i) => i.kind === "blocker");
    const req = pi.items.find((i) => i.title === "Staff calendar view");
    h.intel.store.updateItem({ ...(req ?? pi.items[0]!), dependsOn: [blocker?.id ?? ""] });
    h.setNow(NOW);
    const a = ofKind(prep(h), "chase")[0];
    expect(a?.effort).toBe("send_draft");
    expect(a?.draft).toMatchObject({ kind: "message", to: "Acme" });
    expect(a?.draft?.text).toContain("Staging API key");
    expect(a?.draft?.text).toContain("Staff calendar view");
    expect(a?.draft?.text).toContain("10 days");
  });

  it("follow_up: due-soon promise gets a message; evidence of done makes mark_promise_done primary", () => {
    const h = harness();
    confirmed(h);
    const p: PromiseInput = { id: "m1", projectId: "p1", projectName: "Acme", text: "Send the API docs", dueDate: "2026-10-10", meetingTitle: "Weekly", meetingAt: "2026-10-08T10:00:00.000Z", looksDone: false };
    const a = ofKind(prep(h, [], [p, { ...p, id: "far", dueDate: "2026-12-30" }]), "follow_up");
    expect(a).toHaveLength(1);
    expect(a[0]?.draft?.kind).toBe("message");
    expect(a[0]?.whyNow).toMatch(/overdue/);
    const done = ofKind(prep(h, [], [{ ...p, looksDone: true }]), "follow_up")[0];
    expect(done?.primary.op).toEqual({ op: "mark_promise_done", meetingItemId: "m1" });
    expect(done?.draft?.text).toMatch(/done/);
    expect((a[0]?.score ?? 0)).toBeGreaterThanOrEqual(30);
  });

  it("step and demo: verified work gives a one-tap step and a demo agenda of unseen items", () => {
    const h = harness();
    const ids = confirmed(h);
    for (const id of ids) h.intel.verifyItem(id);
    const as = prep(h);
    const step = ofKind(as, "step")[0];
    expect(step?.primary.op).toEqual({ op: "mark_step", step: "live" });
    const demo = ofKind(as, "demo")[0];
    expect(demo?.primary.op).toEqual({ op: "mark_demo" });
    expect(demo?.draft?.kind).toBe("agenda");
    expect(demo?.draft?.text).toContain("Online booking form");
  });

  it("is deterministic across runs and sorted by score then id", () => {
    const h = harness();
    confirmed(h);
    h.intel.store.addProposal({ projectId: "p1", kind: "new_requirement", material: true, summary: "Add SMS reminders" }, NOW);
    const a = prep(h); const b = prep(h);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    for (let i = 1; i < a.length; i++) {
      const x = a[i - 1]; const y = a[i];
      if (x && y) expect(x.score > y.score || (x.score === y.score && x.id < y.id)).toBe(true);
    }
  });
});

describe("next service", () => {
  function service(h: H, ledger = fakeLedger(), meetings = fakeMeetings(), progress: ProgressReport[] = []) {
    return createNextService({ db: h.db, intel: h.intel, meetings, work: { progress: () => progress }, ledger: ledger.ledger, now: () => new Date(NOW) });
  }

  it("refuses hand_to_ezcoder and stale ids with 409", () => {
    const h = harness();
    confirmed(h);
    const next = service(h);
    const build = next.next().queue.find((a) => a.kind === "build");
    expect(build).toBeDefined();
    const err = (() => { try { next.act(build?.id ?? "", { op: "hand_to_ezcoder" }); } catch (e) { return e; } return null; })();
    expect(err).toBeInstanceOf(NextError);
    expect(err).toMatchObject({ statusCode: 409, message: "Pew starts EZ Coder after you say yes; DAVE never starts work" });
    expect(() => next.act("0123456789abcdef", { op: "copy" })).toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(() => next.act(build?.id ?? "", { op: "mark_demo" })).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it("accept_proposals resolves every proposal in one transaction and records the act", () => {
    const h = harness();
    confirmed(h);
    const s = h.intel.store;
    s.addProposal({ projectId: "p1", kind: "new_requirement", material: true, summary: "Add SMS reminders" }, NOW);
    s.addProposal({ projectId: "p1", kind: "new_requirement", material: true, summary: "Add a waiting list" }, NOW);
    const l = fakeLedger();
    const next = service(h, l);
    const batch = next.next().queue.find((a) => a.primary.op.op === "accept_proposals");
    expect(batch).toBeDefined();
    const res = next.act(batch?.id ?? "", { op: "accept_proposals" });
    expect(res).toMatchObject({ ok: true, op: "accept_proposals" });
    expect(s.pendingProposals()).toHaveLength(0);
    expect(l.acted).toHaveLength(1);
    expect(res.next.queue.some((a) => a.id === batch?.id)).toBe(false);
  });

  it("resolveProposals is all-or-nothing", () => {
    const h = harness();
    const s = h.intel.store;
    const a = s.addProposal({ projectId: "p1", kind: "new_requirement", material: true, summary: "Add SMS reminders" }, NOW);
    const b = s.addProposal({ projectId: "p1", kind: "new_requirement", material: true, summary: "Add a waiting list" }, NOW);
    h.intel.resolveProposal(b?.id ?? "", false, null);
    expect(() => h.intel.resolveProposals([a?.id ?? "", b?.id ?? ""], true, null)).toThrow(/already resolved/);
    expect(s.proposal(a?.id ?? "")?.status).toBe("pending");
  });

  it("skip hides an action until its fingerprint changes; defer until its date", () => {
    const h = harness();
    confirmed(h);
    const pi = h.intel.addItem("p1", { kind: "blocker", title: "Staging API key", owner: "client" });
    const blocker = pi.items.find((i) => i.kind === "blocker");
    const l = fakeLedger();
    const next = service(h, l);
    const chase = next.next().queue.find((a) => a.kind === "chase");
    expect(chase).toBeDefined();
    const after = next.act(chase?.id ?? "", { op: "skip", note: "Asked on Slack" });
    expect(after.next.queue.some((a) => a.id === chase?.id)).toBe(false);
    expect(after.next.skipped).toBe(1);
    h.intel.patchItem(blocker?.id ?? "", { dueDate: "2026-10-20" });
    const back = next.next().queue.find((a) => a.id === chase?.id);
    expect(back).toBeDefined();
    expect(back?.fingerprint).not.toBe(chase?.fingerprint);

    next.act(chase?.id ?? "", { op: "defer", date: "2026-10-14" });
    expect(next.next().queue.some((a) => a.id === chase?.id)).toBe(false);
    expect(l.skips.get(chase?.id ?? "")).toMatchObject({ kind: "defer", until: "2026-10-14T00:00:00.000Z" });
  });

  it("follow_up keeps only firm promises and mark_promise_done goes to meetings", () => {
    const h = harness();
    confirmed(h);
    const base = { recordingId: "r1", kind: "commitment" as const, quote: "", atSeconds: 0, speaker: "Me", speakerRole: "me" as const, projectId: "p1", projectName: "Acme", projectSource: null, duePhrase: null,
      dueDate: "2026-10-15", feature: null, status: "looks_done" as const, suggestedStatus: "done" as const, statusSource: "evidence" as const, statusNote: null, statusChangedAt: null, edited: false, agentRunId: null,
      createdAt: NOW, updatedAt: NOW, meetingTitle: "Weekly", meetingAt: "2026-10-08T10:00:00.000Z", meetingUrl: null, strengthSource: "rule" as const, deliverable: null };
    const items = [
      { ...base, id: "firm", text: "I'll send the API docs by Friday", quote: "I'll send the API docs by Friday", strength: "firm" as const },
      { ...base, id: "idea", text: "We could maybe add export someday", quote: "We could maybe add export someday", strength: "tentative" as const },
    ] satisfies MeetingItem[];
    const m = fakeMeetings(items);
    const next = service(h, fakeLedger(), m);
    const fus = next.next().queue.filter((a) => a.kind === "follow_up");
    expect(fus).toHaveLength(1);
    next.act(fus[0]?.id ?? "", { op: "mark_promise_done" });
    expect(m.done).toEqual(["firm:done"]);
  });
});
