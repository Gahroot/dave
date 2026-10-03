import { describe, expect, it } from "vitest";
import {
  CHECK_RESULT, CONNECTION, CRITERION_REPORTED, FRESHNESS, INBOX_CATEGORY, INBOX_KIND, ITEM_KIND, ITEM_STATUS, MEETING_STATUS,
  MILESTONE_STATUS, NEXT_STEP, PROMISE_GROUP, PROMISE_STATE, RUN_STATUS, TONES, checkResult, hasRail, type StatusSpec,
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
