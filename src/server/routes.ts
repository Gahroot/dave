import type { FastifyInstance } from "fastify";
import { refresh, withAttention } from "../model/refresh.ts";
import { emptySummary } from "../shared/types.ts";
import type { AttentionAction, ProjectSummary } from "../shared/types.ts";
import type { SourcePaths } from "../shared/paths.ts";
import type { Repo } from "../db/repo.ts";

const EDITABLE = ["recentFocus", "completed", "unfinished", "suggestedNextAction"] as const;
type EditableField = (typeof EDITABLE)[number];
const MAX_LEN = 400;

/**
 * Read-only toward the outside world, read/write toward our own store. Every
 * route works without the user ever having supplied anything; the mutating
 * routes are optional conveniences.
 */
export function registerRoutes(app: FastifyInstance, paths: SourcePaths, repo: Repo,
  options: { clock?: () => Date; refresh?: typeof refresh } = {}): void {
  const clock = options.clock ?? (() => new Date());
  const scan = options.refresh ?? refresh;
  let refreshError: string | undefined;
  let inFlight: Promise<Awaited<ReturnType<typeof refresh>>> | null = null;
  // A write to our own store invalidates the stored snapshot. Starts dirty so a
  // snapshot persisted by an earlier process is never served stale.
  let dirty = true;
  let localRevision = 0;

  // simplification: single in-process refresh lock; one user, one process.
  const refreshOnce = () => {
    const revision = localRevision;
    inFlight ??= scan(paths, repo, clock()).then((portfolio) => {
      dirty = revision !== localRevision;
      refreshError = undefined;
      return withAttention(portfolio, repo, clock());
    }).catch((error: unknown) => {
      dirty = true;
      refreshError = "Update failed. Showing the last saved snapshot; retry when ready.";
      const previous = repo.latest();
      if (!previous) throw error;
      return { ...withAttention(previous, repo, clock()), stale: true, refreshError };
    }).finally(() => { inFlight = null; });
    return inFlight;
  };

  const stored = () => {
    const latest = repo.latest();
    return latest ? { ...withAttention(latest, repo, clock()), stale: !!refreshError ||
      clock().getTime() - Date.parse(latest.generatedAt) >= 60_000, refreshError } : null;
  };
  const current = async () => {
    const snapshot = stored();
    return dirty || !snapshot || snapshot.stale ? refreshOnce() : snapshot;
  };

  app.get("/api/portfolio", async () => current());
  app.post("/api/refresh", async () => refreshOnce());
  app.get("/api/issues", async () => ({ issues: repo.issues() }));
  app.get("/api/health", async () => ({ ok: true, appHome: paths.appHome }));

  /** Optional: pin keeps a project in Active, hide removes it from both views. */
  app.post("/api/projects/:id/override", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!repo.projects().some((p) => p.id === id)) {
      return reply.code(404).send({ error: "unknown project" });
    }
    const body = (req.body ?? {}) as { pinned?: unknown; hidden?: unknown };
    const next: { pinned?: boolean; hidden?: boolean } = {};
    if (typeof body.pinned === "boolean") next.pinned = body.pinned;
    if (typeof body.hidden === "boolean") next.hidden = body.hidden;
    if (Object.keys(next).length === 0) {
      return reply.code(400).send({ error: "expected pinned and/or hidden booleans" });
    }
    const override = repo.setOverride(id, next, new Date().toISOString());
    dirty = true;
    localRevision++;
    return { ok: true, override };
  });

  /** Optional: correct a generated summary. Corrections survive regeneration. */
  app.post("/api/projects/:id/summary", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!repo.projects().some((p) => p.id === id)) {
      return reply.code(404).send({ error: "unknown project" });
    }
    // A project with no generated summary yet can still be described by hand;
    // the empty summary is the starting point rather than an error.
    const stored = repo.summary(id);
    const base = stored?.summary ?? emptySummary(new Date().toISOString());

    const body = (req.body ?? {}) as Partial<Record<EditableField, unknown>>;
    const next: ProjectSummary = { ...base, edited: true };
    let changed = false;
    for (const field of EDITABLE) {
      const value = body[field];
      if (value === undefined) continue;
      if (value !== null && typeof value !== "string") {
        return reply.code(400).send({ error: `${field} must be a string or null` });
      }
      next[field] = value === null ? null : String(value).slice(0, MAX_LEN);
      changed = true;
    }
    if (!changed) return reply.code(400).send({ error: "no editable fields supplied" });

    repo.saveSummary(id, stored?.fingerprint ?? "", next);
    dirty = true;
    localRevision++;
    return { ok: true, summary: next };
  });

  const validId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(id);
  app.post("/api/attention/seen", async (req, reply) => {
    const body = req.body as { ids?: unknown } | null;
    if (!body || !Array.isArray(body.ids) || body.ids.length > 100 || !body.ids.every(validId)) {
      return reply.code(400).send({ error: "expected up to 100 item IDs" });
    }
    const ids = body.ids as string[];
    if (ids.some((id) => !repo.hasInboxItem(id))) return reply.code(404).send({ error: "unknown attention item" });
    repo.markSeen(ids, clock().toISOString());
    return { ok: true };
  });
  app.post("/api/attention/:id/:action", async (req, reply) => {
    const { id, action } = req.params as { id: string; action: string };
    if (!validId(id) || !["handled", "tomorrow", "dismiss", "undo"].includes(action)) {
      return reply.code(400).send({ error: "invalid attention action or ID" });
    }
    if (!repo.hasInboxItem(id)) return reply.code(404).send({ error: "unknown attention item" });
    repo.attentionAction(id, action as AttentionAction, clock());
    return { ok: true, portfolio: stored() };
  });

  /** Compatibility endpoint; also never triggers an external rescan. */
  app.post("/api/inbox/:id/:action", async (req, reply) => {
    const { id, action } = req.params as { id: string; action: string };
    if (action !== "acknowledge" && action !== "dismiss") {
      return reply.code(400).send({ error: "unknown action" });
    }
    if (!repo.hasInboxItem(id)) return reply.code(404).send({ error: "unknown inbox item" });
    repo.attentionAction(id, action === "acknowledge" ? "handled" : "dismiss", clock());
    return { ok: true, inbox: repo.inbox(clock()), portfolio: stored() };
  });
}
