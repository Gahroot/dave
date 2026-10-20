import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ledgerService } from "../src/intel/ledger.ts";
import { registerReviewRoutes } from "../src/server/review-routes.ts";
import { intelHarness } from "./intel-fixture.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

async function fixture() {
  const h = intelHarness([{ id: "p1", name: "DAVE" }, { id: "p2", name: "Acme" }]);
  const ledger = ledgerService(h.db, { now: () => new Date("2026-10-12T09:00:00.000Z"), projectName: (id) => (id === "p1" ? "DAVE" : id === "p2" ? "Acme" : null) });
  const app: FastifyInstance = Fastify();
  registerReviewRoutes(app, ledger, h.intel);
  await app.ready();
  cleanups.push(async () => { await app.close(); h.close(); });
  const insert = h.db.prepare(`INSERT INTO recommendation_log(id, scope, project_id, objective_id, action_kind, title, score, recommended_at, outcome, outcome_basis, outcome_at, actual_project_id, actual_ref)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 1; i <= 3; i++) insert.run(`r${i}`, "global", "p1", `o${i}`, "build", `Pick ${i}`, 5, `2026-10-0${i}T09:00:00.000Z`, "overridden", "observed", `2026-10-0${i}T10:00:00.000Z`, "p2", `e${i}`);
  return { app, h };
}

describe("review routes", () => {
  it("validates days", async () => {
    const { app } = await fixture();
    expect((await app.inject({ url: "/api/intel/recommendations/review" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/intel/recommendations/review?days=7" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/intel/recommendations/review?days=90" })).statusCode).toBe(200);
    for (const d of ["6", "91", "abc", "7.5", "-7"]) expect((await app.inject({ url: `/api/intel/recommendations/review?days=${d}` })).statusCode).toBe(400);
  });

  it("applies a live suggestion through direction and refuses a stale one with 409", async () => {
    const { app, h } = await fixture();
    const report = (await app.inject({ url: "/api/intel/recommendations/review?days=30" })).json();
    expect(report.totals.overridden).toBe(3);
    expect(report.suggestions).toHaveLength(1);
    const id = report.suggestions[0].id as string;
    expect((await app.inject({ method: "POST", url: "/api/intel/recommendations/suggestions/apply", payload: { id, extra: 1 } })).statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: "/api/intel/recommendations/suggestions/apply", payload: { id } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().applied).toBe(true);
    expect(h.intel.direction("p2").priority).toBe(2);
    // The same three overrides were used up by this change; DAVE must not offer priority 1 on the same history.
    expect(ok.json().report.suggestions).toEqual([]);
    const stale = await app.inject({ method: "POST", url: "/api/intel/recommendations/suggestions/apply", payload: { id } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("That suggestion no longer applies");
    expect(h.intel.direction("p2").priority).toBe(2);
  });
});
