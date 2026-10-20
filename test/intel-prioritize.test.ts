import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { emptyActivity } from "../src/shared/types.ts";
import { intelHarness } from "./intel-fixture.ts";

let h: ReturnType<typeof intelHarness>;
afterEach(() => h?.close());
const pend = (kind: string) => h.intel.store.pendingProposals().filter((p) => p.kind === kind);

describe("prioritiser scenarios", () => {
  it("C: client credentials blocker => access objective, human only, no coding brief", async () => {
    h = intelHarness();
    h.addItem({ id: "r1", recordingId: "1", kind: "suggestion", role: "client", text: "Integrate Stripe payments" });
    h.addItem({ id: "b1", recordingId: "1", kind: "commitment", role: "client", text: "We need to send you the Stripe API credentials" });
    await h.intel.reconcile();
    h.intel.resolveProposal(pend("new_requirement")[0]!.id, true, null);
    const o = h.intel.projectIntel("p1").objective!;
    expect(o.category).toBe("access_configuration");
    expect(o.humanOnly).toBe(true);
    expect(o.brief).toBeNull();
    expect(o.blockers[0]?.owner).toBe("client");
    expect(o.objective.toLowerCase()).toContain("unblocked");
  });

  it("D: imminent acceptance deadline outranks low urgency; order is stable", async () => {
    h = intelHarness([{ id: "p1", name: "Acme" }, { id: "p2", name: "Beta" }]);
    h.addItem({ id: "a", recordingId: "1", project: "p1", text: "Deliver pilot for acceptance", due: "2026-10-14" });
    h.addItem({ id: "b", recordingId: "2", project: "p2", text: "Polish dashboard colours", due: "2026-12-30" });
    await h.intel.reconcile();
    const f1 = h.intel.focus();
    expect(f1.top?.projectId).toBe("p1");
    expect(f1.top?.scoreReasons.some((r) => r.code.startsWith("deadline"))).toBe(true);
    await h.intel.reconcile();
    const f2 = h.intel.focus();
    expect(f2.queue.map((o) => o.id)).toEqual(f1.queue.map((o) => o.id));
    expect(f2.queue.map((o) => o.score)).toEqual(f1.queue.map((o) => o.score));
  });

  it("D: ties break deterministically", async () => {
    h = intelHarness([{ id: "p1", name: "Zed" }, { id: "p2", name: "Alpha" }]);
    h.addItem({ id: "a", recordingId: "1", project: "p1", text: "Send report", due: "2026-10-20" });
    h.addItem({ id: "b", recordingId: "2", project: "p2", text: "Send report", due: "2026-10-20" });
    await h.intel.reconcile();
    const q = h.intel.focus().queue;
    expect(q[0]?.score).toBe(q[1]?.score);
    expect(q.map((o) => o.projectName)).toEqual(["Alpha", "Zed"]);
  });

  it("B: implementation observed => testing objective; project not accepted", async () => {
    const activity = { ...emptyActivity(), lastCommitAt: "2026-10-11T10:00:00.000Z", recentCommitSubjects: ["Add CSV export to invoices"] };
    h = intelHarness([{ id: "p1", name: "Acme", extra: { activity } }]);
    h.addItem({ id: "s1", recordingId: "1", kind: "suggestion", role: "client", text: "CSV export of invoices" });
    await h.intel.reconcile();
    h.intel.resolveProposal(pend("new_requirement")[0]!.id, true, null);
    await h.intel.reconcile();
    const info = h.intel.projectIntel("p1");
    expect(info.objective?.category).toBe("testing");
    expect(info.outcome?.stage ?? h.intel.focus().projects[0]?.stage).not.toBe("accepted");
    expect(h.intel.focus().projects[0]?.stage).toBe("validation");
  });

  it("E: brief is plain text for coding, and src/intel never imports agents", async () => {
    h = intelHarness();
    h.addItem({ id: "s1", recordingId: "1", kind: "suggestion", role: "client", text: "Add CSV export" });
    await h.intel.reconcile();
    h.intel.resolveProposal(pend("new_requirement")[0]!.id, true, null);
    const o = h.intel.projectIntel("p1").objective!;
    expect(o.category).toBe("coding");
    expect(typeof o.brief).toBe("string");
    expect(o.brief).toContain("Definition of done");
    expect(h.intel.brief(o.id)).toBe(o.brief);
    expect(o.brief).toContain(`\n\nDAVE-Objective: ${o.id}\nDAVE-Items: ${o.targetItemIds.join(",")}\n`);
    expect(o.brief).toContain(`When you commit, add the trailer \`DAVE-Objective: ${o.id}\`.`);
    for (const f of fs.readdirSync("src/intel")) expect(fs.readFileSync(`src/intel/${f}`, "utf8")).not.toMatch(/agents\//);
  });

  it("bells and whistles never become a build objective unless you move them to the finish line", () => {
    h = intelHarness();
    h.intel.addItem("p1", { kind: "requirement", title: "Dark mode for the dashboard" });
    const info = h.intel.addItem("p1", { kind: "requirement", title: "Booking calendar view" });
    const polish = info.items.find((i) => i.title === "Dark mode for the dashboard");
    const builds = (pi: typeof info) => [pi.objective, ...pi.otherActions].filter((o) => o?.category === "coding").map((o) => o?.objective);
    expect(builds(info)).toEqual(["Deliver requirement: Booking calendar view"]);
    expect(info.plan.extras.map((t) => t.itemId)).toEqual([polish?.id]);
    const moved = h.intel.patchItem(polish?.id ?? "", { lane: "finish_line" });
    expect(builds(moved)).toContain("Deliver requirement: Dark mode for the dashboard");
    expect(moved.plan.extras).toEqual([]);
  });
});
