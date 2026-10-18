import { randomBytes } from "node:crypto";
import type { Db } from "../db/index.ts";
import { intelStore } from "../intel/store.ts";
import type { IntelItem, ItemStatus as IntelStatus, Proposal } from "../intel/types.ts";
import { meetingStore } from "../meetings/store.ts";
import type { ItemStatus as MeetingStatus } from "../meetings/types.ts";
import { keepReason, linkedIntelItems, linkedProposals, meetingSourceIds } from "./links.ts";
import { classifyNoise, countByBucket, filterEntries } from "./noise.ts";
import {
  MAX_PREVIEW_ENTRIES,
  type TriageAction, type TriageBatch, type TriageEntry, type TriageFilter, type TriagePreview, type TriageResult,
  type TriageSkip, type TriageSource, type TriageUndoResult,
} from "./types.ts";

/**
 * Clean up: bulk clear or mark done, cascading across meeting items, plan items and drafted decisions.
 * Never deletes. Every batch records each changed row before and after, so undo restores only rows still as it left them.
 */

export type TriageServiceOptions = {
  db: Db;
  now: () => Date;
  projectName: (projectId: string) => string | null;
  onChanged: () => void;
};

type Value = string | number | null;
type Snap = Record<string, Value>;
type Table = "meeting_items" | "intel_items" | "intel_proposals";
type Change = { table: Table; id: string; before: Snap; after: Snap };

/** Only these columns are ever recorded or restored (column names never come from input). */
const COLUMNS: Record<Table, readonly string[]> = {
  meeting_items: ["status", "status_source", "status_note", "status_changed_at", "suggested_status", "suggested_evidence_json"],
  intel_items: ["status", "basis"],
  intel_proposals: ["status", "note", "resolved_at"],
};
/** Compared before undoing; meeting timestamps are restored but not compared. */
const COMPARED: Record<Table, readonly string[]> = {
  meeting_items: ["status", "status_source", "status_note", "suggested_status", "suggested_evidence_json"],
  intel_items: ["status", "basis"],
  intel_proposals: ["status", "note", "resolved_at"],
};
const TOUCHES_UPDATED_AT: Record<Table, boolean> = { meeting_items: true, intel_items: true, intel_proposals: false };
const TABLES: readonly Table[] = ["meeting_items", "intel_items", "intel_proposals"];

const CLEAR_NOTE = "Cleared in clean-up";
const DONE_NOTE = "Marked done in clean-up";
const plural = (n: number): string => `${n} item${n === 1 ? "" : "s"}`;

function parseChanges(json: string): Change[] {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return []; }
  const list = raw && typeof raw === "object" && Array.isArray((raw as { changes?: unknown }).changes) ? (raw as { changes: unknown[] }).changes : [];
  const out: Change[] = [];
  for (const c of list) {
    if (!c || typeof c !== "object") continue;
    const { table, id, before, after } = c as Record<string, unknown>;
    const t = TABLES.find((x) => x === table);
    if (!t || typeof id !== "string" || !isSnap(before, t) || !isSnap(after, t)) continue;
    out.push({ table: t, id, before, after });
  }
  return out;
}
function isSnap(v: unknown, table: Table): v is Snap {
  return !!v && typeof v === "object" && Object.entries(v).every(([k, x]) => COLUMNS[table].includes(k) && (x === null || typeof x === "string" || typeof x === "number"));
}

export function createTriageService(options: TriageServiceOptions) {
  const { db, now, projectName, onChanged } = options;
  const meetings = meetingStore(db);
  const intel = intelStore(db, (id) => projectName(id) ?? id);

  function tx<T>(fn: () => T): T {
    db.exec("SAVEPOINT triage");
    try { const v = fn(); db.exec("RELEASE triage"); return v; }
    catch (e) { db.exec("ROLLBACK TO triage; RELEASE triage"); throw e; }
  }
  function snap(table: Table, id: string, columns: readonly string[]): Snap | null {
    const row = db.prepare(`SELECT ${columns.join(", ")} FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const out: Snap = {};
    for (const c of columns) { const v = row[c]; out[c] = typeof v === "string" || typeof v === "number" ? v : null; }
    return out;
  }

  function entries(at: Date): TriageEntry[] {
    return classifyNoise({
      meetingItems: meetings.items({ statuses: ["open", "looks_done"], limit: 5000 }),
      proposals: intel.pendingProposals(), intelItems: intel.allItems(), now: at, projectName,
    });
  }

  function preview(filter: TriageFilter = {}): TriagePreview {
    const at = now();
    const all = entries(at);
    const shown = filterEntries(all, filter, at);
    const withConfirmed = filter.includeConfirmed ? shown.length : filterEntries(all, { ...filter, includeConfirmed: true }, at).length;
    return {
      generatedAt: at.toISOString(), entries: shown.slice(0, MAX_PREVIEW_ENTRIES), counts: countByBucket(shown),
      total: shown.length, confirmedHidden: withConfirmed - shown.length,
    };
  }

  function apply(req: { keys: readonly string[]; action: TriageAction; source: TriageSource }): TriageResult {
    const nowDate = now();
    const at = nowDate.toISOString();
    const byKey = new Map(entries(nowDate).map((e) => [e.key, e]));
    const skipped: TriageSkip[] = [];
    const kept: TriageSkip[] = [];
    const acted: TriageEntry[] = [];
    for (const key of [...new Set(req.keys)]) {
      const e = byKey.get(key);
      if (!e) skipped.push({ key, reason: "gone" });
      else if (req.action === "done" && e.kind !== "promise" && e.bucket !== "looks_done") skipped.push({ key, reason: "Only promises and looks-done items can be marked done" });
      else acted.push(e);
    }
    const changes: Change[] = [];
    const record = (table: Table, id: string, write: () => void): void => {
      const before = snap(table, id, COLUMNS[table]);
      write();
      const after = snap(table, id, COMPARED[table]);
      if (before && after && COMPARED[table].some((c) => before[c] !== after[c])) changes.push({ table, id, before, after });
    };
    const setMeeting = (id: string, status: MeetingStatus, note: string): void =>
      record("meeting_items", id, () => { meetings.setItemStatus(id, { status, source: "user", note }, at); });
    const setIntel = (item: IntelItem, fields: { status: IntelStatus; basis?: IntelItem["basis"] }): void =>
      record("intel_items", item.id, () => { intel.updateItem({ ...item, ...fields, updatedAt: at }); });
    const resolve = (p: Proposal, status: "accepted" | "rejected"): void =>
      record("intel_proposals", p.id, () => { intel.resolveProposal(p.id, status, CLEAR_NOTE, at); });

    const note = req.action === "done" ? DONE_NOTE : CLEAR_NOTE;
    const perProject = new Map<string, number>();
    tx(() => {
      const closed = new Set((db.prepare("SELECT id FROM meeting_items WHERE status IN ('done','dropped')").all() as { id: string }[]).map((r) => String(r.id)));
      const meetingEntries = acted.filter((e) => e.key.startsWith("m:"));
      for (const e of meetingEntries) {
        const id = e.key.slice(2);
        setMeeting(id, req.action === "done" ? "done" : "dropped", note);
        closed.add(id);
      }
      const intelItems = intel.allItems();
      for (const e of meetingEntries) {
        const id = e.key.slice(2);
        const closedItems: string[] = [];
        for (const item of linkedIntelItems(intelItems, id)) {
          const current = intel.item(item.id);
          if (!current) continue;
          const reason = keepReason(current, closed);
          if (reason === null) { setIntel(current, { status: req.action === "done" ? "done" : "dropped" }); closedItems.push(current.id); }
          else if (current.status === "done" || current.status === "dropped" || current.status === "obsolete") closedItems.push(current.id);
          else kept.push({ key: e.key, reason });
        }
        for (const p of linkedProposals(intel.pendingProposals(), closedItems, [id])) resolve(p, "rejected");
      }
      for (const e of acted.filter((x) => x.key.startsWith("p:"))) {
        const p = intel.proposal(e.key.slice(2));
        if (p && p.status === "pending") resolveDecision(p, closed);
      }
      for (const e of acted) if (e.projectId) perProject.set(e.projectId, (perProject.get(e.projectId) ?? 0) + 1);
      for (const [projectId, n] of [...perProject].sort((a, b) => a[0].localeCompare(b[0]))) {
        intel.addChange({ projectId, kind: "item_updated", summary: req.action === "done" ? `Marked ${plural(n)} done in clean-up` : `Cleared ${plural(n)} in clean-up`, sources: ["human"] }, at);
      }
    });

    function resolveDecision(p: Proposal, closed: Set<string>): void {
      const sources = meetingSourceIds(p.provenance);
      const fields = p.patch.fields as Record<string, unknown> | undefined;
      const status = fields?.status;
      const target = typeof p.patch.itemId === "string" ? intel.item(p.patch.itemId) : null;
      if ((p.kind === "mark_complete" || p.kind === "mark_obsolete") && sources.length > 0 && sources.every((s) => closed.has(s))
        && (status === "done" || status === "obsolete") && target) {
        setIntel(target, { status, basis: "confirmed" });
        resolve(p, "accepted");
        return;
      }
      resolve(p, "rejected");
      if (p.kind !== "new_commitment") return;
      const item = p.itemId ? intel.item(p.itemId) : null;
      if (item && item.basis === "inferred" && !item.locked && item.status !== "dropped") setIntel(item, { status: "dropped" });
      for (const id of [...sources].sort()) {
        const m = meetings.item(id);
        if (m && (m.status === "open" || m.status === "looks_done") && m.statusSource !== "user") { setMeeting(id, "dropped", CLEAR_NOTE); closed.add(id); }
      }
    }

    const changed = changes.length ? acted.length : 0;
    const summary = changed === 0 ? "Nothing changed." : req.action === "done" ? `Marked ${plural(changed)} done.` : `Cleared ${plural(changed)}.`;
    let batchId: string | null = null;
    if (changes.length) {
      batchId = `tb-${randomBytes(12).toString("hex")}`;
      db.prepare("INSERT INTO triage_batches(id, created_at, source, action, summary, count, changes_json, undone_at) VALUES (?,?,?,?,?,?,?,NULL)")
        .run(batchId, at, req.source, req.action, summary, changed, JSON.stringify({ changes }));
      onChanged();
    }
    return { batchId, changed, skipped, kept, summary };
  }

  function undo(batchId: string): TriageUndoResult | null {
    const row = db.prepare("SELECT changes_json, undone_at FROM triage_batches WHERE id = ?").get(batchId) as { changes_json: string; undone_at: string | null } | undefined;
    if (!row) return null;
    if (row.undone_at !== null) return { restored: 0, skipped: 0 };
    const at = now().toISOString();
    const result = tx(() => {
      let restored = 0, skipped = 0;
      for (const c of parseChanges(row.changes_json)) {
        const compared = Object.keys(c.after);
        const current = snap(c.table, c.id, compared);
        if (!current || compared.some((k) => current[k] !== c.after[k])) { skipped++; continue; }
        const cols = Object.keys(c.before);
        const sets = [...cols.map((k) => `${k} = ?`), ...(TOUCHES_UPDATED_AT[c.table] ? ["updated_at = ?"] : [])];
        const values: Value[] = [...cols.map((k) => c.before[k] ?? null), ...(TOUCHES_UPDATED_AT[c.table] ? [at] : [])];
        db.prepare(`UPDATE ${c.table} SET ${sets.join(", ")} WHERE id = ?`).run(...values, c.id);
        restored++;
      }
      db.prepare("UPDATE triage_batches SET undone_at = ? WHERE id = ?").run(at, batchId);
      return { restored, skipped };
    });
    onChanged();
    return result;
  }

  function batches(limit = 20): TriageBatch[] {
    const rows = db.prepare("SELECT id, created_at, source, action, summary, count, undone_at FROM triage_batches ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(Math.min(Math.max(1, limit), 200)) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id), createdAt: String(r.created_at), source: r.source === "voice" ? "voice" : "ui", action: r.action === "done" ? "done" : "clear",
      summary: String(r.summary), count: Number(r.count), undoneAt: typeof r.undone_at === "string" ? r.undone_at : null,
    }));
  }

  return { preview, apply, undo, batches };
}

export type TriageService = ReturnType<typeof createTriageService>;
