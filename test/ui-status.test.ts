import { READINESS_LEVELS } from "../src/intel/types.ts";
import { describe, expect, it } from "vitest";
import {
  CHECK_RESULT, CONNECTION, CRITERION_REPORTED, FRESHNESS, INBOX_CATEGORY, INBOX_KIND, ITEM_KIND, ITEM_STATUS, MEETING_STATUS,
  MILESTONE_STATUS, NEXT_STEP, EVIDENCE_STATE, READINESS_LEVEL, BASIS, PROPOSAL_KIND, OBJECTIVE_CATEGORY, DELIVERY_FRESHNESS, SOURCE_HEALTH, PROMISE_GROUP, PROMISE_STATE, RUN_STATUS, TONES, checkResult, hasRail, type StatusSpec,
} from "../src/ui/status.ts";

const maps: Record<string, Readonly<Record<string, StatusSpec>>> = {
  RUN_STATUS, MILESTONE_STATUS, NEXT_STEP, CHECK_RESULT, CRITERION_REPORTED, FRESHNESS, INBOX_KIND, INBOX_CATEGORY,
  PROMISE_GROUP, PROMISE_STATE, ITEM_STATUS, ITEM_KIND, MEETING_STATUS, CONNECTION,
};

describe("status language", () => {
  it("gives every state a known tone, an icon and a non-empty word", () => {
    for (const [name, map] of Object.entries(maps)) {
      for (const [state, spec] of Object.entries(map)) {
        expect(TONES, `${name}.${state}`).toContain(spec.tone);
        expect(spec.icon, `${name}.${state}`).toBeTruthy();
        expect(spec.label.trim(), `${name}.${state}`).not.toBe("");
      }
    }
  });
  it("covers every agent run status with the words the desk already uses", () => {
    expect(Object.keys(RUN_STATUS).sort()).toEqual(["accepted", "checking", "failed", "interrupted", "queued", "review", "running", "starting", "stopped", "waiting"]);
    expect(RUN_STATUS.accepted.label).toBe("Accepted, not merged");
    expect(RUN_STATUS.running.label).toBe("Working");
  });
  it("keeps honesty boundaries visible: cached, reported and accepted are never drawn as verified", () => {
    expect(FRESHNESS.cached.tone).not.toBe(FRESHNESS.checked.tone);
    expect(FRESHNESS.cached.icon).not.toBe(FRESHNESS.checked.icon);
    expect(CRITERION_REPORTED.met.tone).toBe("gray");
    expect(RUN_STATUS.accepted.label).toMatch(/not merged/);
  });
  it("maps every Delivery Intelligence state and keeps its honesty boundaries", () => {
    expect(Object.keys(EVIDENCE_STATE).sort()).toEqual(["blocked", "implementation_observed", "not_implemented", "unknown", "unverified", "verified"]);
    expect(Object.keys(READINESS_LEVEL).sort()).toEqual([...READINESS_LEVELS].sort());
    expect(Object.keys(BASIS).sort()).toEqual(["confirmed", "inferred"]);
    expect(Object.keys(PROPOSAL_KIND)).toHaveLength(9);
    expect(Object.keys(OBJECTIVE_CATEGORY)).toHaveLength(8);
    expect(Object.keys(DELIVERY_FRESHNESS).sort()).toEqual(["aging", "fresh", "never", "stale"]);
    expect(Object.keys(SOURCE_HEALTH).sort()).toEqual(["degraded", "not_connected", "ok", "unavailable"]);
    for (const k of ["implementation_observed", "unverified", "unknown", "not_implemented"] as const) expect(EVIDENCE_STATE[k].tone).not.toBe("green");
    expect(EVIDENCE_STATE.verified.tone).toBe("green");
    expect(EVIDENCE_STATE.implementation_observed.icon).not.toBe(EVIDENCE_STATE.verified.icon);
    expect(BASIS.inferred.tone).toBe("violet");
    expect(READINESS_LEVEL.code_complete.tone).not.toBe("green");
    expect(READINESS_LEVEL.client_accepted.tone).toBe("green");
    expect(DELIVERY_FRESHNESS.never.tone).not.toBe(DELIVERY_FRESHNESS.fresh.tone);
  });
  it("only puts rails on states that need the owner or flag a failure", () => {
    expect(hasRail(RUN_STATUS.review.tone)).toBe(true);
    expect(hasRail(RUN_STATUS.failed.tone)).toBe(true);
    expect(hasRail(RUN_STATUS.running.tone)).toBe(false);
    expect(hasRail(RUN_STATUS.accepted.tone)).toBe(false);
    expect(hasRail(RUN_STATUS.queued.tone)).toBe(false);
  });
  it.each([
    [0, true, "passed"], [1, true, "failed"], [null, true, "interrupted"], [undefined, true, "interrupted"], [0, false, "not-run"],
  ] as const)("classifies check exit %s (ran %s) as %s", (exit, ran, expected) => {
    expect(checkResult(exit, ran)).toBe(expected);
  });
});
