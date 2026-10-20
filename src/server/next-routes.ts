import type { FastifyInstance, FastifyReply } from "fastify";
import { NextError, type NextActBody, type NextService } from "../intel/next.ts";
import { BRIEFING_CALLERS, PREPARED_OPS, type BriefingCaller, type PreparedOpName } from "../intel/next-types.ts";

const ID = /^[a-f0-9]{16}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const NOTE_MAX = 500;
const bad = (message = "Invalid request"): never => { throw new NextError(400, message); };

function isoDate(v: unknown): string {
  if (typeof v !== "string" || !ISO_DATE.test(v) || !Number.isFinite(Date.parse(v))) return bad("Invalid date");
  const d = v.slice(0, 10);
  if (new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d) return bad("Invalid date");
  return v;
}

function actBody(raw: unknown): NextActBody {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad();
  const b: Record<string, unknown> = { ...raw };
  if (Object.keys(b).some((k) => k !== "op" && k !== "note" && k !== "date")) return bad();
  const op = typeof b.op === "string" && (PREPARED_OPS as readonly string[]).includes(b.op) ? PREPARED_OPS.find((o) => o === b.op) : undefined;
  if (!op) return bad("Unknown op");
  const out: NextActBody = { op: op satisfies PreparedOpName };
  if (b.note !== undefined) {
    if (typeof b.note !== "string" || b.note.length > NOTE_MAX) return bad("Notes are at most 500 characters");
    const t = b.note.trim();
    if (t) out.note = t;
  }
  if (b.date !== undefined) out.date = isoDate(b.date);
  return out;
}

/** Prepared next actions and the briefing, under the guarded /api/intel prefix. */
export function registerNextRoutes(app: FastifyInstance, next: NextService): void {
  function fail(error: unknown, reply: FastifyReply) {
    if (error instanceof NextError) return reply.code(error.statusCode).send({ error: error.message });
    throw error;
  }

  app.get("/api/intel/next", async () => next.next());

  app.post<{ Params: { id: string } }>("/api/intel/next/:id/act", async (req, reply) => {
    try {
      if (!ID.test(req.params.id)) bad("Invalid id");
      return next.act(req.params.id, actBody(req.body ?? {}));
    } catch (e) { return fail(e, reply); }
  });

  app.get<{ Querystring: Record<string, unknown> }>("/api/intel/briefing", async (req, reply) => {
    try {
      const q = req.query ?? {};
      if (Object.keys(q).some((k) => k !== "since" && k !== "caller")) bad();
      const since = q.since === undefined ? undefined : isoDate(q.since);
      let caller: BriefingCaller | undefined;
      if (q.caller !== undefined) {
        caller = BRIEFING_CALLERS.find((c) => c === q.caller);
        if (!caller) bad("caller must be pew, voice or ui");
      }
      return next.briefing({ since, caller });
    } catch (e) { return fail(e, reply); }
  });
}
