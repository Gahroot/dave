import { describe, expect, it } from "vitest";
import { ACTIVE_LIMIT, ACTIVE_THRESHOLD, scoreRelevance, selectActive } from "../src/core/relevance.ts";
import { emptyActivity } from "../src/shared/types.ts";
import type { TechnicalActivity } from "../src/shared/types.ts";
import { ago, NOW, task } from "./helpers.ts";

const NONE = { pinned: false, hidden: false };

function activity(over: Partial<TechnicalActivity> = {}): TechnicalActivity {
  return { ...emptyActivity(), ...over };
}

describe("relevance", () => {
  it("caps fifty projects deterministically, promoting human requests over ordinary pinned activity", () => {
    const projects = Array.from({ length: 50 }, (_, n) => {
      const tasks = n < 20 ? [task({ title: "needs your input" })] : [];
      const override = { pinned: n >= 20, hidden: n === 0 };
      return { id: String(n), name: `p${String(n).padStart(2, "0")}`, tasks, override,
        relevance: scoreRelevance(activity(), tasks, override, NOW) };
    });
    const selected = selectActive(projects);
    expect(selected).toHaveLength(12);
    expect(selected.every((p) => p.tasks.length === 1 && !p.override.hidden)).toBe(true);
    expect(selectActive([...projects].reverse()).map((p) => p.id)).toEqual(selected.map((p) => p.id));
  });
  it("scores nothing for a project with no evidence — silence is not a penalty", () => {
    const r = scoreRelevance(activity(), [], NONE, NOW);
    expect(r.score).toBe(0);
    expect(r.reasons).toEqual([]);
    expect(r.tier).toBe("other");
  });

  it("never docks points for absent business metadata", () => {
    // Two projects identical in evidence must score identically; there is no
    // metadata input to this function at all.
    const a = scoreRelevance(activity({ lastAgentSessionAt: ago(2) }), [], NONE, NOW);
    const b = scoreRelevance(activity({ lastAgentSessionAt: ago(2) }), [], NONE, NOW);
    expect(a.score).toBe(b.score);
  });

  it("puts a project with a running worker and a fresh session under Active", () => {
    const r = scoreRelevance(
      activity({ runningTaskCount: 1, lastAgentSessionAt: ago(3) }),
      [task({ status: "in_progress" })],
      NONE,
      NOW,
    );
    expect(r.score).toBeGreaterThanOrEqual(ACTIVE_THRESHOLD);
    expect(r.tier).toBe("active");
    expect(r.reasons.map((x) => x.code)).toContain("running-worker");
  });

  it("ranks a recent session above an old one", () => {
    const fresh = scoreRelevance(activity({ lastAgentSessionAt: ago(2) }), [], NONE, NOW);
    const old = scoreRelevance(activity({ lastAgentSessionAt: ago(24 * 10) }), [], NONE, NOW);
    expect(fresh.score).toBeGreaterThan(old.score);
  });

  it("rewards repeated activity across several days", () => {
    const burst = scoreRelevance(activity({ lastAgentSessionAt: ago(5), activeDayCount: 1 }), [], NONE, NOW);
    const sustained = scoreRelevance(activity({ lastAgentSessionAt: ago(5), activeDayCount: 5 }), [], NONE, NOW);
    expect(sustained.score).toBeGreaterThan(burst.score);
    expect(sustained.reasons.map((r) => r.code)).toContain("repeat-activity");
  });

  it("counts pending and blocked agent work", () => {
    const r = scoreRelevance(
      activity({ blockedTaskCount: 1 }),
      [task({ status: "pending" }), task({ id: "t2", status: "blocked" })],
      NONE,
      NOW,
    );
    const codes = r.reasons.map((x) => x.code);
    expect(codes).toContain("open-task");
    expect(codes).toContain("blocked-task");
  });

  it("counts uncommitted work only alongside a recent session", () => {
    const orphaned = scoreRelevance(activity({ dirty: true, dirtyFileCount: 3 }), [], NONE, NOW);
    const live = scoreRelevance(
      activity({ dirty: true, dirtyFileCount: 3, lastAgentSessionAt: ago(20) }),
      [],
      NONE,
      NOW,
    );
    expect(orphaned.reasons.map((r) => r.code)).not.toContain("uncommitted-work");
    expect(live.reasons.map((r) => r.code)).toContain("uncommitted-work");
  });

  it("recent commits raise relevance, stale ones barely register", () => {
    const fresh = scoreRelevance(activity({ lastCommitAt: ago(10) }), [], NONE, NOW);
    const stale = scoreRelevance(activity({ lastCommitAt: ago(24 * 60) }), [], NONE, NOW);
    expect(fresh.score).toBeGreaterThan(stale.score);
    expect(stale.score).toBe(0);
  });

  it("pinning forces Active without any other evidence", () => {
    const r = scoreRelevance(activity(), [], { pinned: true, hidden: false }, NOW);
    expect(r.tier).toBe("active");
    expect(r.reasons[0]!.code).toBe("pinned");
  });

  it("hiding keeps a project out of Active however busy it is", () => {
    const r = scoreRelevance(
      activity({ runningTaskCount: 2, lastAgentSessionAt: ago(1) }),
      [task({ status: "in_progress" })],
      { pinned: false, hidden: true },
      NOW,
    );
    expect(r.score).toBeGreaterThan(ACTIVE_THRESHOLD);
    expect(r.tier).toBe("other");
  });

  it("leaves room for every project that is genuinely in flight", () => {
    // Real portfolios run ~10 live projects at once; a smaller cap would drop
    // a busy project purely because the list was full.
    expect(ACTIVE_LIMIT).toBeGreaterThanOrEqual(12);
  });

  it("explains every point it awards", () => {
    const r = scoreRelevance(
      activity({ runningTaskCount: 1, lastAgentSessionAt: ago(1), lastCommitAt: ago(5) }),
      [],
      NONE,
      NOW,
    );
    expect(r.score).toBe(r.reasons.reduce((s, x) => s + x.points, 0));
    for (const reason of r.reasons) expect(reason.detail.length).toBeGreaterThan(0);
  });
});
