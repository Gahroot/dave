import type { Db } from "../db/index.ts";
import { LIMITS, END_REASONS, type EndReason, type ToolCallResponse, type TranscriptLine, type VoiceHistoryEntry } from "./types.ts";

export type ActionStatus = "done" | "needs_confirmation" | "confirmed" | "cancelled" | "refused" | "failed";
export const KEEP_SESSIONS = 100;
export const KEEP_ACTIONS = 2000;

type SessionRow = { id: string; started_at: string; ended_at: string | null; project_id: string | null; model: string; voice: string; end_reason: string | null; transcript_json: string; summary: string | null };

export function capTranscript(lines: readonly TranscriptLine[]): TranscriptLine[] {
  return lines.slice(-LIMITS.transcriptLines).map((l) => ({ role: l.role, at: l.at, text: l.text.slice(0, LIMITS.transcriptLineChars) }));
}

/** Plain-words summary from the action journal; no model involved. */
export function summarize(projectName: string | null, done: string[], lines: number): string {
  const parts: string[] = [];
  parts.push(projectName ? `Talked about ${projectName}.` : "Talked about the portfolio.");
  if (done.length) parts.push(`Done: ${done.slice(0, 6).join("; ")}${done.length > 6 ? `; and ${done.length - 6} more` : ""}.`);
  else parts.push("No changes were made.");
  if (!lines) parts.push("No transcript was saved.");
  return parts.join(" ").slice(0, 600);
}

export function voiceStore(db: Db, now: () => Date, projectName: (id: string) => string | null = () => null) {
  const prune = () => {
    db.prepare(`DELETE FROM voice_sessions WHERE id NOT IN (SELECT id FROM voice_sessions ORDER BY started_at DESC, id DESC LIMIT ?)`).run(KEEP_SESSIONS);
    db.prepare(`DELETE FROM voice_actions WHERE session_id NOT IN (SELECT id FROM voice_sessions)`).run();
    db.prepare(`DELETE FROM voice_actions WHERE rowid NOT IN (SELECT rowid FROM voice_actions ORDER BY at DESC, rowid DESC LIMIT ?)`).run(KEEP_ACTIONS);
  };
  return {
    create(s: { id: string; projectId: string | null; model: string; voice: string }): void {
      db.prepare("INSERT INTO voice_sessions(id, started_at, project_id, model, voice) VALUES (?,?,?,?,?)").run(s.id, now().toISOString(), s.projectId, s.model, s.voice);
      prune();
    },
    session(id: string): { id: string; projectId: string | null; endedAt: string | null } | null {
      const r = db.prepare("SELECT id, project_id, ended_at FROM voice_sessions WHERE id=?").get(id) as { id: string; project_id: string | null; ended_at: string | null } | undefined;
      return r ? { id: r.id, projectId: r.project_id, endedAt: r.ended_at } : null;
    },
    end(id: string, reason: EndReason, transcript: readonly TranscriptLine[]): string | null {
      const row = db.prepare("SELECT * FROM voice_sessions WHERE id=?").get(id) as SessionRow | undefined;
      if (!row) return null;
      if (row.ended_at) return row.summary;
      const lines = capTranscript(transcript);
      const done = (db.prepare("SELECT summary FROM voice_actions WHERE session_id=? AND status IN ('done','confirmed') ORDER BY at, rowid").all(id) as { summary: string }[])
        .map((a) => a.summary).filter((s) => s && !s.startsWith("Read:"));
      const summary = summarize(row.project_id ? projectName(row.project_id) : null, done, lines.length);
      db.prepare("UPDATE voice_sessions SET ended_at=?, end_reason=?, transcript_json=?, summary=? WHERE id=?").run(now().toISOString(), reason, JSON.stringify(lines), summary, id);
      return summary;
    },
    getAction(sessionId: string, callId: string): ToolCallResponse | null {
      const r = db.prepare("SELECT result_json FROM voice_actions WHERE session_id=? AND call_id=?").get(sessionId, callId) as { result_json: string } | undefined;
      if (!r) return null;
      try { return JSON.parse(r.result_json) as ToolCallResponse; } catch { return null; }
    },
    putAction(sessionId: string, callId: string, name: string, status: ActionStatus, summary: string, result: ToolCallResponse): void {
      db.prepare("INSERT OR REPLACE INTO voice_actions(session_id, call_id, name, status, summary, result_json, at) VALUES (?,?,?,?,?,?,?)")
        .run(sessionId, callId, name, status, summary.slice(0, 300), JSON.stringify(result), now().toISOString());
    },
    history(limit = 20): VoiceHistoryEntry[] {
      const rows = db.prepare("SELECT * FROM voice_sessions ORDER BY started_at DESC, id DESC LIMIT ?").all(Math.max(1, Math.min(100, limit))) as SessionRow[];
      return rows.map((r) => {
        let lines = 0;
        try { const t: unknown = JSON.parse(r.transcript_json); lines = Array.isArray(t) ? t.length : 0; } catch { lines = 0; }
        const n = db.prepare("SELECT COUNT(*) AS n FROM voice_actions WHERE session_id=?").get(r.id) as { n: number };
        return {
          id: r.id, startedAt: r.started_at, endedAt: r.ended_at, projectId: r.project_id, projectName: r.project_id ? projectName(r.project_id) : null,
          model: r.model, voice: r.voice, endReason: END_REASONS.find((e) => e === r.end_reason) ?? null, summary: r.summary, lines, actions: n.n,
        };
      });
    },
    lastSummary(): string | null {
      const r = db.prepare("SELECT summary FROM voice_sessions WHERE summary IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT 1").get() as { summary: string } | undefined;
      return r?.summary ?? null;
    },
  };
}
export type VoiceStore = ReturnType<typeof voiceStore>;
