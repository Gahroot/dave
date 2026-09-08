import type { Db } from "./index.ts";
import type {
  AttentionAction,
  AttentionCandidate,
  DetectionSignal,
  EvidenceRef,
  InboxItem,
  InboxKind,
  InboxStatus,
  Portfolio,
  PortfolioIssue,
  ProjectAlias,
  ProjectOverride,
  ProjectSummary,
} from "../shared/types.ts";

function parse<T>(json: string | null): T | null {
  if (json === null) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

const NO_OVERRIDE: ProjectOverride = { pinned: false, hidden: false };

/**
 * The command center's own store. Summaries are generated and refreshed
 * automatically; overrides are optional and only ever set by an explicit,
 * one-click user action.
 */
export function repo(db: Db) {
  const q = {
    selectProject: db.prepare("SELECT id FROM projects WHERE canonical_path = ?"),
    insertProject: db.prepare(
      "INSERT INTO projects (id, canonical_path, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
    ),
    touchProject: db.prepare("UPDATE projects SET last_seen_at = ?, name = ? WHERE id = ?"),
    allProjects: db.prepare("SELECT id, canonical_path, name FROM projects ORDER BY name"),
    insertAlias: db.prepare(
      `INSERT INTO project_aliases (project_id, path, source, observed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, path, source) DO UPDATE SET observed_at = excluded.observed_at`,
    ),
    aliases: db.prepare(
      "SELECT path, source FROM project_aliases WHERE project_id = ? ORDER BY path, source",
    ),
    insertSignal: db.prepare(
      "INSERT OR IGNORE INTO project_signals (project_id, signal) VALUES (?, ?)",
    ),
    signals: db.prepare("SELECT signal FROM project_signals WHERE project_id = ? ORDER BY signal"),
    getSummary: db.prepare("SELECT * FROM project_summaries WHERE project_id = ?"),
    putSummary: db.prepare(
      `INSERT INTO project_summaries (project_id, fingerprint, payload, generated_at, edited)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         fingerprint = excluded.fingerprint, payload = excluded.payload,
         generated_at = excluded.generated_at, edited = excluded.edited`,
    ),
    getOverride: db.prepare("SELECT pinned, hidden FROM project_overrides WHERE project_id = ?"),
    putOverride: db.prepare(
      `INSERT INTO project_overrides (project_id, pinned, hidden, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         pinned = excluded.pinned, hidden = excluded.hidden, updated_at = excluded.updated_at`,
    ),
    upsertInbox: db.prepare(
      `INSERT INTO inbox_items (id, project_id, kind, title, detail, evidence_json, status, dedupe_key, created_at, active)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, 1)
       ON CONFLICT(dedupe_key) DO NOTHING`,
    ),
    listInbox: db.prepare(
      `SELECT i.*, p.name FROM inbox_items i LEFT JOIN projects p ON p.id = i.project_id
       LEFT JOIN project_overrides o ON o.project_id = i.project_id
       WHERE (? = 1 OR (i.active = 1 AND i.status = 'open' AND COALESCE(o.hidden, 0) = 0))
       ORDER BY i.urgency DESC, p.name, i.subject_key, i.id`,
    ),
    resolveInbox: db.prepare("UPDATE inbox_items SET status = ?, resolved_at = ? WHERE id = ?"),
    getInbox: db.prepare("SELECT 1 FROM inbox_items WHERE id = ?"),
    insertSnapshot: db.prepare(
      "INSERT INTO snapshots (id, generated_at, payload) VALUES (?, ?, ?)",
    ),
    latestSnapshot: db.prepare(
      "SELECT payload FROM snapshots ORDER BY generated_at DESC, rowid DESC LIMIT 1",
    ),
    trimSnapshots: db.prepare(
      "DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY generated_at DESC, rowid DESC LIMIT 20)",
    ),
    insertIssue: db.prepare(
      `INSERT INTO adapter_issues (id, snapshot_id, adapter, path, message, observed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    recentIssues: db.prepare(
      "SELECT adapter, path, message, observed_at FROM adapter_issues ORDER BY observed_at DESC LIMIT ?",
    ),
  };

  return {
    ensureProject(canonicalPath: string, name: string, now: string): string {
      const row = q.selectProject.get(canonicalPath) as { id: string } | undefined;
      if (row) {
        q.touchProject.run(now, name, row.id);
        return row.id;
      }
      const id = crypto.randomUUID();
      q.insertProject.run(id, canonicalPath, name, now, now);
      return id;
    },

    projects(): { id: string; canonical_path: string; name: string }[] {
      return q.allProjects.all() as never;
    },

    recordAlias(id: string, path: string, source: string, now: string): void {
      q.insertAlias.run(id, path, source, now);
    },

    aliases(id: string): ProjectAlias[] {
      return q.aliases.all(id) as ProjectAlias[];
    },

    recordSignals(id: string, signals: Iterable<DetectionSignal>): void {
      for (const s of signals) q.insertSignal.run(id, s);
    },

    signals(id: string): DetectionSignal[] {
      return (q.signals.all(id) as { signal: string }[]).map((r) => r.signal as DetectionSignal);
    },

    /** Cached summary plus the fingerprint it was generated from. */
    summary(id: string): { summary: ProjectSummary; fingerprint: string } | null {
      const row = q.getSummary.get(id) as
        | { fingerprint: string; payload: string; edited: number }
        | undefined;
      if (!row) return null;
      const summary = parse<ProjectSummary>(row.payload);
      return summary ? { summary: { ...summary, edited: row.edited === 1 }, fingerprint: row.fingerprint } : null;
    },

    saveSummary(id: string, fingerprint: string, summary: ProjectSummary): void {
      q.putSummary.run(
        id,
        fingerprint,
        JSON.stringify(summary),
        summary.generatedAt,
        summary.edited ? 1 : 0,
      );
    },

    override(id: string): ProjectOverride {
      const row = q.getOverride.get(id) as { pinned: number; hidden: number } | undefined;
      return row ? { pinned: row.pinned === 1, hidden: row.hidden === 1 } : { ...NO_OVERRIDE };
    },

    setOverride(id: string, next: Partial<ProjectOverride>, now: string): ProjectOverride {
      const current = this.override(id);
      const merged = { ...current, ...next };
      q.putOverride.run(id, merged.pinned ? 1 : 0, merged.hidden ? 1 : 0, now);
      return merged;
    },

    proposeInbox(
      item: {
        projectId: string | null;
        kind: InboxKind;
        title: string;
        detail: string;
        evidence?: EvidenceRef[];
        dedupeKey: string;
      },
      now: string,
    ): void {
      q.upsertInbox.run(
        crypto.randomUUID(),
        item.projectId,
        item.kind,
        item.title,
        item.detail,
        JSON.stringify(item.evidence ?? []),
        item.dedupeKey,
        now,
      );
    },

    transaction<T>(work: () => T): T {
      db.exec("SAVEPOINT attention_write");
      try {
        const result = work();
        db.exec("RELEASE attention_write");
        return result;
      } catch (error) {
        db.exec("ROLLBACK TO attention_write; RELEASE attention_write");
        throw error;
      }
    },

    reconcileAttention(candidates: AttentionCandidate[], observedProjects: string[], now: string, baseline = false): void {
      this.transaction(() => {
        for (const id of observedProjects) {
          db.prepare("UPDATE inbox_items SET active = 0 WHERE project_id = ? AND subject_key IS NOT NULL").run(id);
        }
        for (const c of candidates) {
          // Only exact legacy evidence inherits an outcome, never a guessed match.
          if (c.legacyDedupeKey) {
            db.prepare(`UPDATE inbox_items SET subject_key = ?, fingerprint = ?
              WHERE dedupe_key = ? AND project_id = ? AND subject_key IS NULL AND title = ? AND detail = ?
              AND NOT EXISTS (SELECT 1 FROM inbox_items WHERE project_id = ? AND subject_key = ? AND fingerprint = ?)`)
              .run(c.subjectKey, c.fingerprint, c.legacyDedupeKey, c.projectId, c.title, c.detail, c.projectId, c.subjectKey, c.fingerprint);
          }
          db.prepare(`UPDATE inbox_items SET active = 0
            WHERE project_id = ? AND subject_key = ? AND fingerprint != ?`)
            .run(c.projectId, c.subjectKey, c.fingerprint);
          db.prepare(`INSERT INTO inbox_items
            (id,project_id,kind,title,detail,evidence_json,dedupe_key,created_at,subject_key,fingerprint,active,last_observed_at,seen_at,urgency,next_step)
            VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)
            ON CONFLICT(project_id,subject_key,fingerprint) DO UPDATE SET
              active=1,last_observed_at=excluded.last_observed_at,title=excluded.title,detail=excluded.detail,
              evidence_json=excluded.evidence_json,urgency=excluded.urgency,next_step=excluded.next_step`)
            .run(crypto.randomUUID(), c.projectId, c.kind, c.title, c.detail, JSON.stringify(c.evidence),
              JSON.stringify([c.projectId,c.subjectKey,c.fingerprint]), now, c.subjectKey, c.fingerprint,
              now, baseline ? now : null, c.urgency, c.nextStep);
        }
      });
    },

    attentionAction(id: string, action: AttentionAction, now: Date): void {
      if (!this.hasInboxItem(id)) throw new Error("Unknown attention item");
      let snooze: string | null = null;
      if (action === "tomorrow") {
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(9, 0, 0, 0);
        snooze = tomorrow.toISOString();
      }
      const status = action === "handled" ? "acknowledged" : action === "dismiss" ? "dismissed" : "open";
      db.prepare("UPDATE inbox_items SET status=?,resolved_at=?,snoozed_until=? WHERE id=?")
        .run(status, status === "open" ? null : now.toISOString(), snooze, id);
    },

    markSeen(ids: string[], now: string): void {
      this.transaction(() => {
        for (const id of ids) {
          if (!this.hasInboxItem(id)) throw new Error("Unknown attention item");
          db.prepare("UPDATE inbox_items SET seen_at = COALESCE(seen_at, ?) WHERE id = ?").run(now, id);
        }
      });
    },

    // simplification: local snapshots carry all history; add server-side pagination
    // when revision volume outgrows this dozens-of-projects dashboard.
    inbox(now = new Date(), history = false): InboxItem[] {
      return (
        q.listInbox.all(history ? 1 : 0) as {
          id: string;
          project_id: string | null;
          kind: string;
          title: string;
          detail: string;
          evidence_json: string;
          status: string;
          created_at: string;
          resolved_at: string | null;
          name: string | null;
          subject_key: string | null;
          fingerprint: string | null;
          active: number;
          last_observed_at: string | null;
          snoozed_until: string | null;
          seen_at: string | null;
          urgency: number;
          next_step: string;
        }[]
      ).map((row) => ({
        id: row.id,
        projectId: row.project_id,
        projectName: row.name,
        kind: row.kind as InboxKind,
        title: row.title,
        detail: row.detail,
        evidence: parse<EvidenceRef[]>(row.evidence_json) ?? [],
        status: row.status as InboxStatus,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at,
        subjectKey: row.subject_key,
        fingerprint: row.fingerprint,
        active: row.active === 1,
        lastObservedAt: row.last_observed_at,
        snoozedUntil: row.snoozed_until,
        seenAt: row.seen_at,
        urgency: row.urgency,
        nextStep: row.next_step,
      })).filter((item) => history || (item.active && item.status === "open" &&
        (!item.snoozedUntil || Date.parse(item.snoozedUntil) <= now.getTime())));

    },

    hasInboxItem(id: string): boolean {
      return q.getInbox.get(id) !== undefined;
    },

    resolveInbox(id: string, status: InboxStatus, now: string): void {
      q.resolveInbox.run(status, now, id);
    },

    saveSnapshot(portfolio: Portfolio): string {
      const snapshotId = crypto.randomUUID();
      q.insertSnapshot.run(snapshotId, portfolio.generatedAt, JSON.stringify(portfolio));
      for (const i of portfolio.issues) {
        q.insertIssue.run(crypto.randomUUID(), snapshotId, i.adapter, i.path, i.message, i.observedAt);
      }
      q.trimSnapshots.run();
      return snapshotId;
    },

    latest(): Portfolio | null {
      const row = q.latestSnapshot.get() as { payload: string } | undefined;
      return row ? parse<Portfolio>(row.payload) : null;
    },

    issues(limit = 200): PortfolioIssue[] {
      return (
        q.recentIssues.all(limit) as {
          adapter: string;
          path: string | null;
          message: string;
          observed_at: string;
        }[]
      ).map((r) => ({
        adapter: r.adapter,
        path: r.path,
        message: r.message,
        observedAt: r.observed_at,
      }));
    },
  };
}

export type Repo = ReturnType<typeof repo>;
