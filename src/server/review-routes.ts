import type { FastifyInstance } from "fastify";
import type { IntelService } from "../intel/service.ts";
import type { LedgerService } from "../intel/ledger.ts";
import type { ReviewDirection } from "../intel/review.ts";
import { REVIEW_DEFAULT_DAYS, REVIEW_MAX_DAYS, REVIEW_MIN_DAYS } from "../intel/ledger-types.ts";
import { strictObject } from "./provider-routes.ts";

/**
 * Recommendation review (under the guarded /api/intel prefix). Suggestions apply only when the owner asks, through the
 * existing direction patch; a suggestion that no longer appears in a fresh review is refused with 409.
 */
export function registerReviewRoutes(app: FastifyInstance, ledger: LedgerService, intel: IntelService): void {
  const directionOf = (projectId: string): ReviewDirection | null => {
    if (!intel.knownProject(projectId)) return null;
    const d = intel.direction(projectId);
    return { priority: d.priority, updatedAt: d.updatedAt };
  };
  const report = (days: number) => ledger.reviewWith(days, directionOf);

  app.get<{ Querystring: Record<string, unknown> }>("/api/intel/recommendations/review", async (req, reply) => {
    const raw = req.query.days;
    if (raw === undefined) return report(REVIEW_DEFAULT_DAYS);
    if (typeof raw !== "string" || !/^\d{1,3}$/.test(raw)) return reply.code(400).send({ error: `days must be a whole number from ${REVIEW_MIN_DAYS} to ${REVIEW_MAX_DAYS}` });
    const days = Number(raw);
    if (days < REVIEW_MIN_DAYS || days > REVIEW_MAX_DAYS) return reply.code(400).send({ error: `days must be a whole number from ${REVIEW_MIN_DAYS} to ${REVIEW_MAX_DAYS}` });
    return report(days);
  });

  app.post("/api/intel/recommendations/suggestions/apply", async (req, reply) => {
    strictObject(req.body, ["id"]);
    const id = req.body.id;
    if (typeof id !== "string" || id.length < 1 || id.length > 200) return reply.code(400).send({ error: "Invalid request" });
    const found = report(REVIEW_DEFAULT_DAYS).suggestions.find((s) => s.id === id);
    if (!found) return reply.code(409).send({ error: "That suggestion no longer applies" });
    if (!intel.knownProject(found.op.projectId)) return reply.code(409).send({ error: "That suggestion no longer applies" });
    intel.setDirection(found.op.projectId, { priority: found.op.priority });
    return { applied: true, report: report(REVIEW_DEFAULT_DAYS) };
  });
}
