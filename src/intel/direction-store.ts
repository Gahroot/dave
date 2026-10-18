import { randomBytes } from "node:crypto";
import type { Db } from "../db/index.ts";
import type { DirectionNote } from "./types.ts";
import { DIRECTION_NOTES_PER_PROJECT } from "./types.ts";

/** Stored direction row (focus ids as saved; the service drops ids that no longer exist at read time). */
export type StoredDirection = { projectId: string; paidWhen: string | null; priority: number | null; focusItemIds: string[]; updatedAt: string };

type DirectionRow = { project_id: string; paid_when: string | null; priority: number | null; focus_json: string; updated_at: string };
type NoteRow = { id: string; project_id: string | null; text: string; source: string; created_at: string };

const parseIds = (json: string): string[] => {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string"))] : [];
  } catch { return []; }
};
const toNote = (r: NoteRow): DirectionNote => ({ id: r.id, projectId: r.project_id, text: r.text, source: r.source === "voice" ? "voice" : "ui", createdAt: r.created_at });

/**
 * CRUD for project_direction and direction_notes. No validation beyond storage shape: the service validates.
 * Notes cap: when a project (or the portfolio, project_id NULL) passes DIRECTION_NOTES_PER_PROJECT notes,
 * the oldest are pruned so the newest 200 stay.
 */
export function directionStore(db: Db) {
  function get(projectId: string): StoredDirection | null {
    const r = db.prepare("SELECT * FROM project_direction WHERE project_id=?").get(projectId) as DirectionRow | undefined;
    return r ? { projectId: r.project_id, paidWhen: r.paid_when, priority: r.priority, focusItemIds: parseIds(r.focus_json), updatedAt: r.updated_at } : null;
  }
  function all(): StoredDirection[] {
    const rows = db.prepare("SELECT project_id FROM project_direction ORDER BY project_id").all() as { project_id: string }[];
    return rows.map((r) => get(r.project_id)).filter((d): d is StoredDirection => !!d);
  }
  function save(d: StoredDirection): void {
    db.prepare(`INSERT INTO project_direction(project_id, paid_when, priority, focus_json, updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET paid_when=excluded.paid_when, priority=excluded.priority, focus_json=excluded.focus_json, updated_at=excluded.updated_at`)
      .run(d.projectId, d.paidWhen, d.priority, JSON.stringify([...new Set(d.focusItemIds)]), d.updatedAt);
  }
  function addNote(projectId: string | null, text: string, source: DirectionNote["source"], at: string): DirectionNote {
    const id = randomBytes(8).toString("hex");
    db.prepare("INSERT INTO direction_notes(id, project_id, text, source, created_at) VALUES (?,?,?,?,?)").run(id, projectId, text, source, at);
    const scope = projectId === null ? "project_id IS NULL" : "project_id=?";
    const args = projectId === null ? [] : [projectId];
    db.prepare(`DELETE FROM direction_notes WHERE ${scope} AND id NOT IN (SELECT id FROM direction_notes WHERE ${scope} ORDER BY created_at DESC, rowid DESC LIMIT ?)`)
      .run(...args, ...args, DIRECTION_NOTES_PER_PROJECT);
    return { id, projectId, text, source, createdAt: at };
  }
  function note(id: string): DirectionNote | null {
    const r = db.prepare("SELECT * FROM direction_notes WHERE id=?").get(id) as NoteRow | undefined;
    return r ? toNote(r) : null;
  }
  function deleteNote(id: string): boolean {
    return Number(db.prepare("DELETE FROM direction_notes WHERE id=?").run(id).changes) > 0;
  }
  /** "all" = every note; null = portfolio-wide only. Newest first. */
  function notes(projectId: string | null | "all", limit: number): DirectionNote[] {
    const n = Math.max(0, Math.floor(limit));
    const rows = (projectId === "all" ? db.prepare("SELECT * FROM direction_notes ORDER BY created_at DESC, rowid DESC LIMIT ?").all(n)
      : projectId === null ? db.prepare("SELECT * FROM direction_notes WHERE project_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?").all(n)
        : db.prepare("SELECT * FROM direction_notes WHERE project_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(projectId, n)) as NoteRow[];
    return rows.map(toNote);
  }
  return { get, all, save, addNote, note, deleteNote, notes };
}
export type DirectionStore = ReturnType<typeof directionStore>;
