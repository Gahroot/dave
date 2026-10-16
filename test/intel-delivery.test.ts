import { describe, expect, it } from "vitest";
import {
  BEHIND_WEIGHTS, NO_DATE_WEIGHTS, behindScore, copyAllText, deliveryPlan, deliveryProgress, draftDoneWhen, draftGoal, nextMoveText, taskText, whyOf,
  type DeliveryInput,
} from "../src/intel/delivery.ts";
import type { StoredOutcome } from "../src/intel/store.ts";
import type { IntelItem, Proposal } from "../src/intel/types.ts";

/** Pure tests: every input is built fresh per test, and the clock is fixed. */
const NOW = new Date("2026-10-12T09:00:00.000Z");
const FINISH = "Clinic staff book and manage appointments online";

function item(id: string, title: string, over: Partial<IntelItem> = {}): IntelItem {
  return {
    id, projectId: "p1", kind: "requirement", title, detail: null, basis: "confirmed", status: "open", evidenceState: "not_implemented",
    readinessTarget: "client_accepted", readinessReached: null, owner: "me", dueDate: null, acceptance: [], dependsOn: [], locked: false,
    provenance: [], lastSupportedAt: "2026-10-01T00:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    lane: null, goal: null, verifiedAt: null, sentAt: null, reopenCount: 0, ...over,
  };
}

function outcome(over: Partial<StoredOutcome> = {}): StoredOutcome {
  return {
    projectId: "p1", desiredOutcome: FINISH, acceptanceCriteria: [], stageOverride: null, basis: "confirmed", locked: false, provenance: [],
    updatedAt: "2026-10-01T09:00:00.000Z", confirmedAt: "2026-10-01T09:00:00.000Z", startDate: null, targetDate: null,
    liveAt: null, usingAt: null, signedOffAt: null, lastDemoAt: null, ...over,
  };
}

function proposal(id: string, over: Partial<Proposal> = {}): Proposal {
  return {
    id, projectId: "p1", projectName: "Acme", kind: "scope_change", material: true, summary: `Proposal ${id}`, detail: null, itemId: null,
    patch: {}, provenance: [], status: "pending", createdAt: "2026-10-02T00:00:00.000Z", resolvedAt: null, ...over,
  };
}

function input(over: Partial<DeliveryInput> = {}): DeliveryInput {
  return { projectId: "p1", projectName: "Acme", now: NOW, outcome: outcome(), draftPending: false, items: [], pending: [], agentTasks: [], lastClientMeetingAt: null, ...over };
}

const verified = (id: string, title: string, at: string, over: Partial<IntelItem> = {}) =>
  item(id, title, { status: "done", evidenceState: "verified", verifiedAt: at, ...over });

describe("behind score: the plan's worked examples", () => {
  it("70% of the time used, 40% done, 3 days stalled scores 52", () => {
    const b = behindScore({ percentDone: 40, startDate: "2026-10-05", targetDate: "2026-10-15", anchorAt: "2026-10-09T12:00:00.000Z", now: NOW });
    expect(b).toEqual({ score: 52, schedule: 60, distance: 60, stalled: 21, stalledDays: 3, weights: { ...BEHIND_WEIGHTS } });
  });

  it("no target date, 70% done, 10 days stalled scores 46 on the 60/40 weights", () => {
    const b = behindScore({ percentDone: 70, startDate: "2026-09-01", targetDate: null, anchorAt: "2026-10-02", now: NOW });
    expect(b).toEqual({ score: 46, schedule: null, distance: 30, stalled: 70, stalledDays: 10, weights: { ...NO_DATE_WEIGHTS } });
  });

  it("10% of the time used, 5% done, 1 day stalled scores 35", () => {
    const b = behindScore({ percentDone: 5, startDate: "2026-10-11", targetDate: "2026-10-21", anchorAt: "2026-10-11", now: NOW });
    expect(b).toMatchObject({ score: 35, schedule: 10, distance: 95, stalled: 7, stalledDays: 1 });
  });

  it("past the target date the schedule part is 100 unless it is all done; a target on or before the start counts as overdue", () => {
    expect(behindScore({ percentDone: 90, startDate: "2026-09-01", targetDate: "2026-10-10", anchorAt: "2026-10-12", now: NOW }).schedule).toBe(100);
    expect(behindScore({ percentDone: 100, startDate: "2026-09-01", targetDate: "2026-10-10", anchorAt: "2026-10-12", now: NOW }).schedule).toBe(0);
    expect(behindScore({ percentDone: 10, startDate: "2026-10-20", targetDate: "2026-10-20", anchorAt: null, now: NOW }).schedule).toBe(100);
  });

  it("ahead of schedule clamps at 0, a delivered project scores 0, and stalling caps at 100", () => {
    expect(behindScore({ percentDone: 80, startDate: "2026-10-02", targetDate: "2026-10-22", anchorAt: "2026-10-12", now: NOW }).schedule).toBe(0);
    expect(behindScore({ percentDone: 100, startDate: "2026-10-02", targetDate: null, anchorAt: "2026-08-01", now: NOW, delivered: true }).score).toBe(0);
    expect(behindScore({ percentDone: 0, startDate: "2026-06-01", targetDate: null, anchorAt: "2026-06-01", now: NOW }).stalled).toBe(100);
  });
});

describe("delivery progress", () => {
  it("counts only verified finish-line work toward 70%, adds 10% per marked step, and keeps steps separate", () => {
    const p = deliveryProgress(input({
      outcome: outcome({ liveAt: "2026-10-11T08:00:00.000Z" }),
      items: [
        verified("f1", "Booking calendar view", "2026-10-08T10:00:00.000Z"),
        verified("f2", "Reminder emails", "2026-10-10T10:00:00.000Z"),
        item("f3", "Staff rota screen", { dueDate: "2026-11-01" }),
        item("f4", "Clinic opening hours"),
        item("f5", "Holiday closures page", { status: "in_progress" }),
        item("f6", "Fax integration", { status: "dropped" }),
        verified("x1", "Dark mode for the dashboard", "2026-10-11T10:00:00.000Z"),
        item("x2", "Gift cards", { lane: "phase2", dueDate: "2026-12-15" }),
        item("c1", "Send the pilot plan", { kind: "commitment", owner: "me", dueDate: "2026-11-20" }),
        item("c2", "Client sends brand files", { kind: "commitment", owner: "client", dueDate: "2026-12-01" }),
      ],
    }));
    expect(p).toMatchObject({
      confirmed: true, delivered: false, finishLineItems: 5, verifiedItems: 2, percentDone: 38,
      steps: { production_ready: false, live: true, using: false, signed_off: false }, currentStep: "production_ready", stepNumber: 1,
      startDate: "2026-10-01", targetDate: null, suggestedTargetDate: "2026-11-20", lastRealProgressAt: "2026-10-11T10:00:00.000Z", overdue: false,
    });
  });

  it("no finish-line items is 0% and not production-ready; everything verified and signed off is delivered at 100%", () => {
    expect(deliveryProgress(input()).percentDone).toBe(0);
    expect(deliveryProgress(input()).steps.production_ready).toBe(false);
    const done = deliveryProgress(input({
      outcome: outcome({ liveAt: "2026-10-09T00:00:00.000Z", usingAt: "2026-10-10T00:00:00.000Z", signedOffAt: "2026-10-11T00:00:00.000Z", targetDate: "2026-10-05" }),
      items: [verified("f1", "Booking calendar view", "2026-10-08T10:00:00.000Z")],
    }));
    expect(done).toMatchObject({ percentDone: 100, delivered: true, currentStep: null, stepNumber: 5, overdue: false });
    expect(done.behind?.score).toBe(0);
  });

  it("an unconfirmed project is not scored; an overdue one has a full schedule part; a client blocker means waiting on the client", () => {
    expect(deliveryProgress(input({ outcome: null })).behind).toBeNull();
    const late = deliveryProgress(input({
      outcome: outcome({ targetDate: "2026-10-10" }),
      items: [item("f1", "Take card payments through Stripe"), item("k1", "Client provides Stripe credentials", { kind: "blocker", owner: "client" })],
    }));
    expect(late.overdue).toBe(true);
    expect(late.behind?.schedule).toBe(100);
    expect(late.waitingOnClient).toBe(true);
  });
});

describe("goal, done-when and why", () => {
  it("a stored goal wins, a 'so that' detail is used as is, and anything else is drafted and flagged", () => {
    expect(draftGoal(item("a", "Cancel appointments", { goal: "So that front desk sees today's list" }))).toEqual({ goal: "So that front desk sees today's list", drafted: false });
    expect(draftGoal(item("a", "Cancel appointments", { detail: "so that patients can cancel online." }))).toEqual({ goal: "So that patients can cancel online.", drafted: false });
    expect(draftGoal(item("a", "Cancel appointments", { detail: "Patients cancel without calling" }))).toEqual({ goal: "So that patients cancel without calling.", drafted: true });
    expect(draftGoal(item("a", "Cancel appointments"))).toEqual({ goal: "So that the client can cancel appointments.", drafted: true });
  });

  it("done-when uses the acceptance list, otherwise drafts one end-to-end check from the goal", () => {
    expect(draftDoneWhen(item("a", "Cancel appointments", { acceptance: ["A booked slot frees up", " "] }), "So that x.")).toEqual({ doneWhen: ["A booked slot frees up"], drafted: false });
    expect(draftDoneWhen(item("a", "Cancel appointments"), "So that patients cancel without calling.")).toEqual({ doneWhen: ["Patients cancel without calling, checked end to end"], drafted: true });
  });

  it("why quotes the client when a meeting recorded it, else names the finish line, else the agreed scope", () => {
    const quoted = item("a", "Clinic location map", { provenance: [{ sourceKind: "meeting", sourceId: "m1", label: "Call with Acme, 8 Oct", quote: "Patients keep getting lost", observedAt: "2026-10-08T10:00:00.000Z", confidence: "high", link: null }] });
    expect(whyOf(quoted, outcome())).toEqual({ why: "\"Patients keep getting lost\" (Call with Acme, 8 Oct)", source: "Call with Acme, 8 Oct" });
    expect(whyOf(item("a", "Clinic location map"), outcome()).why).toBe(`Part of the agreed finish line: ${FINISH}`);
    expect(whyOf(item("a", "Clinic location map"), null)).toEqual({ why: "Part of the agreed scope", source: null });
  });
});

describe("copyable text", () => {
  it("each task stands alone: goal, why, build, done when and the project context", () => {
    const text = taskText({ goal: "So that patients can find the clinic.", why: "\"Patients keep getting lost\" (Call with Acme, 8 Oct)", build: "Clinic location map", doneWhen: ["The map shows the clinic pin", "Directions open in the phone's map app"] }, { projectName: "Acme", desiredOutcome: FINISH });
    expect(text).toBe([
      "So that patients can find the clinic.",
      "Why: \"Patients keep getting lost\" (Call with Acme, 8 Oct)",
      "Build: Clinic location map",
      "Done when:",
      "- The map shows the clinic pin",
      "- Directions open in the phone's map app",
      `Context: Acme. Finish line: ${FINISH}. Stay within this task; do not deploy, merge or contact the client. Report what you changed and how you checked it.`,
    ].join("\n"));
  });

  it("copy all numbers the tasks, separates them with a blank line and repeats the context in each", () => {
    const tasks = [
      { goal: "So that a.", why: "Why a", build: "Build a", doneWhen: ["A works"] },
      { goal: "So that b.", why: "Why b", build: "Build b", doneWhen: ["B works"] },
    ];
    const blocks = copyAllText(tasks, { projectName: "Acme", desiredOutcome: FINISH }).split("\n\n");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.startsWith("1. So that a.\n")).toBe(true);
    expect(blocks[1]?.startsWith("2. So that b.\n")).toBe(true);
    for (const b of blocks) expect(b).toContain("Context: Acme. Finish line: ");
  });
});

/** A confirmed project with one task of each pause reason, one ready task and a dependency cycle. */
function pausedScenario(): DeliveryInput {
  return input({
    items: [
      item("k1", "Client provides Stripe credentials", { kind: "blocker", owner: "client" }),
      item("w1", "Take card payments through Stripe"),
      item("w2", "Receipt emails after paying", { dependsOn: ["w1"] }),
      item("w3", "Patient intake form", { evidenceState: "blocked" }),
      item("w4", "Waiting room display"),
      item("w5", "Prescription refill requests", { reopenCount: 2 }),
      item("y1", "Doctor profile pages", { dependsOn: ["y2"] }),
      item("y2", "Doctor search filters", { dependsOn: ["y1"] }),
      item("r1", "Clinic location map"),
    ],
    pending: [proposal("pr1", { kind: "scope_change", itemId: "w4", summary: "Waiting room display may be cut" }), proposal("od1", { kind: "outcome_draft" })],
  });
}

describe("delivery plan", () => {
  it("an unconfirmed project's only move is to confirm the finish line; no tasks, but extras are still listed", () => {
    const plan = deliveryPlan(input({
      outcome: null,
      items: [item("f1", "Booking calendar view"), item("x1", "Dark mode for the dashboard")],
      pending: [proposal("od1", { kind: "outcome_draft" })],
    }));
    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0]).toMatchObject({ kind: "confirm_finish_line", proposalId: "od1", proposalKind: "outcome_draft" });
    expect([plan.ready, plan.waiting, plan.sent]).toEqual([[], [], []]);
    expect(plan.copyAll).toBe("");
    expect(plan.extras.map((t) => t.itemId)).toEqual(["x1"]);
    expect(plan.progress.behind).toBeNull();
  });

  it("pauses on a client blocker, a decision, a blocked mark, a bad path, a waiting dependency and a cycle", () => {
    const plan = deliveryPlan(pausedScenario());
    expect(plan.ready.map((t) => t.itemId)).toEqual(["r1"]);
    const why = Object.fromEntries(plan.waiting.map((t) => [t.itemId, [t.waitingOn, t.waitingMoveId]]));
    expect(why).toEqual({
      w1: ["Waiting on the client: Client provides Stripe credentials", "chase:k1"],
      w2: ["After: Take card payments through Stripe", "chase:k1"],
      w3: ["Marked blocked in the plan", null],
      w4: ["Needs your decision: Waiting room display may be cut", "decide:pr1"],
      w5: ["\"Not right\" 2 times: rethink the goal", "rethink:w5"],
      y1: ["After: Doctor search filters", null],
      y2: ["After: Doctor profile pages", null],
    });
    expect(plan.waiting.every((t) => t.state === "waiting")).toBe(true);
    // Moves: decisions, then chases, then rethinks, then the target date; the outcome draft is not a decision.
    expect(plan.moves.map((m) => m.id)).toEqual(["decide:pr1", "chase:k1", "rethink:w5", "target_date"]);
    expect(plan.moves[0]?.why).toContain("1 task is paused on this.");
    expect(plan.moves[1]?.why).toBe("Holds up 1 task: Take card payments through Stripe");
    expect(plan.copyAll.startsWith("1. ")).toBe(true);
    expect(plan.copyAll).not.toContain("2. ");
  });

  it("orders ready work by started, riskiest, due date and dependents, never before its own dependency", () => {
    const plan = deliveryPlan(input({
      items: [
        item("a", "Booking calendar view", { status: "in_progress" }),
        item("b", "Calendar sync with Google"),
        item("c", "Reminder emails", { dueDate: "2026-10-20" }),
        item("d", "Clinic opening hours"),
        item("e", "Holiday closures page", { dueDate: "2026-10-15", dependsOn: ["d"] }),
        item("f", "Staff rota screen"),
      ],
    }));
    expect(plan.ready.map((t) => [t.itemId, t.orderReason])).toEqual([
      ["a", "Already started"],
      ["b", "Riskiest part: prove it works first"],
      ["c", "Due 2026-10-20"],
      ["d", "Unblocks 1 task"],
      ["e", "Due 2026-10-15"],
      ["f", "Next in the agreed scope"],
    ]);
    expect(nextMoveText(plan)).toBe("Set a target date");
    expect(nextMoveText({ moves: [], ready: plan.ready, waiting: [] })).toBe("Send 6 tasks to EZcoder");
  });

  it("copied tasks and tasks already active in EZcoder are sent; a finished EZcoder task does not count", () => {
    const plan = deliveryPlan(input({
      items: [
        item("s1", "Invoice history page", { sentAt: "2026-10-10T12:00:00.000Z" }),
        item("s2", "Appointment reminders by text"),
        item("s3", "Practice newsletter signup"),
      ],
      agentTasks: [
        { title: "Build appointment reminders by text message", status: "running", summary: null },
        { title: "Practice newsletter signup", status: "done", summary: "Built it" },
      ],
    }));
    expect(plan.sent.map((t) => [t.itemId, t.inEzcoder, t.orderReason])).toEqual([
      ["s1", false, "Sent 2026-10-10"],
      ["s2", true, "In EZcoder, matched by title"],
    ]);
    expect(plan.ready.map((t) => t.itemId)).toEqual(["s3"]);
    expect(plan.copyAll).not.toContain("Invoice history page");
  });

  it("built but unchecked work becomes a verify move with its done-when, oldest first; verified work is neither a move nor a task", () => {
    const plan = deliveryPlan(input({
      outcome: outcome({ targetDate: "2026-12-01" }),
      items: [
        item("v1", "Online booking form", { evidenceState: "implementation_observed", updatedAt: "2026-10-09T00:00:00.000Z", acceptance: ["A patient can book a free slot"] }),
        item("v2", "Clinic logo upload", { status: "done", updatedAt: "2026-10-03T00:00:00.000Z" }),
        verified("v3", "Booking calendar view", "2026-10-08T10:00:00.000Z"),
      ],
    }));
    expect(plan.moves.map((m) => m.id)).toEqual(["verify:v2", "verify:v1"]);
    expect(plan.moves[1]?.doneWhen).toEqual(["A patient can book a free slot"]);
    expect([...plan.ready, ...plan.waiting, ...plan.sent]).toEqual([]);
  });

  it("a stored lane wins over DAVE's guess, and extras copy is grouped Extras then Phase 2", () => {
    const plan = deliveryPlan(input({
      items: [
        item("x1", "Dark mode for the dashboard"),
        item("x2", "Export to PDF", { lane: "phase2" }),
        item("x3", "Animated welcome screen", { lane: "finish_line" }),
        item("x4", "Clinic logo upload"),
      ],
    }));
    expect(plan.extras.map((t) => [t.itemId, t.lane, t.laneGuessed])).toEqual([["x1", "extra", true], ["x2", "phase2", false]]);
    expect(plan.ready.map((t) => [t.itemId, t.laneGuessed])).toEqual([["x3", false], ["x4", true]]);
    expect(plan.progress.finishLineItems).toBe(2);
    expect(plan.extrasCopy.split("\n")).toEqual([
      "Extras", "- Dark mode for the dashboard: So that the client can dark mode for the dashboard.", "", "Phase 2", "- Export to PDF: So that the client can export to PDF.",
    ]);
  });

  it("suggests a demo at 3 unseen verified items, or at 1 once production-ready, after the next step", () => {
    const four = (verifiedCount: number) => ["Booking calendar view", "Reminder emails", "Staff rota screen", "Clinic opening hours"].map((t, n) =>
      n < verifiedCount ? verified(`f${n}`, t, `2026-10-0${6 + n}T10:00:00.000Z`) : item(`f${n}`, t));
    const kinds = (i: DeliveryInput) => deliveryPlan(i).moves.map((m) => m.id);
    const base = { outcome: outcome({ targetDate: "2026-12-01" }), lastClientMeetingAt: "2026-10-05T10:00:00.000Z" };
    expect(kinds(input({ ...base, items: four(3) }))).toEqual(["demo"]);
    expect(deliveryPlan(input({ ...base, items: four(3) })).moves[0]?.title).toBe("Show the client 3 verified items");
    expect(kinds(input({ ...base, items: four(2) }))).toEqual([]);
    // A demo after the last verification clears the prompt.
    expect(kinds(input({ ...base, outcome: outcome({ targetDate: "2026-12-01", lastDemoAt: "2026-10-11T00:00:00.000Z" }), items: four(3) }))).toEqual([]);
    // Production-ready: the next step comes first, then a demo for even one unseen item.
    expect(kinds(input({ ...base, lastClientMeetingAt: "2026-10-08T12:00:00.000Z", items: four(4) }))).toEqual(["step:live", "demo"]);
  });

  it("steps come one at a time in order, and a delivered project has no step or target-date move", () => {
    const items = [verified("f1", "Booking calendar view", "2026-10-08T10:00:00.000Z")];
    const ids = (o: StoredOutcome) => deliveryPlan(input({ outcome: o, items, lastClientMeetingAt: "2026-10-09T00:00:00.000Z" })).moves.map((m) => m.id);
    expect(ids(outcome())).toEqual(["step:live", "target_date"]);
    expect(ids(outcome({ liveAt: "2026-10-10T00:00:00.000Z" }))).toEqual(["step:using", "target_date"]);
    expect(ids(outcome({ usingAt: "2026-10-10T00:00:00.000Z" }))).toEqual(["step:live", "target_date"]);
    expect(ids(outcome({ liveAt: "2026-10-10T00:00:00.000Z", usingAt: "2026-10-10T00:00:00.000Z", signedOffAt: "2026-10-11T00:00:00.000Z" }))).toEqual([]);
  });

  it("the target-date move offers the latest agreed due date", () => {
    const plan = deliveryPlan(input({ items: [item("f1", "Reminder emails", { dueDate: "2026-11-01" }), item("c1", "Send the pilot plan", { kind: "commitment", owner: "me", dueDate: "2026-11-20" })] }));
    expect(plan.moves.find((m) => m.kind === "target_date")).toMatchObject({ suggestedDate: "2026-11-20" });
  });

  it("is deterministic: shuffled input gives identical output", () => {
    const a = pausedScenario();
    const b = { ...a, items: [...a.items].reverse(), pending: [...a.pending].reverse() };
    expect(JSON.stringify(deliveryPlan(b))).toBe(JSON.stringify(deliveryPlan(a)));
  });
});
