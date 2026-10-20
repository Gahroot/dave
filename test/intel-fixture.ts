import fs from "node:fs";
import { openDb, type Db } from "../src/db/index.ts";
import { meetingStore } from "../src/meetings/store.ts";
import { intelService, type IntelService, type IntelServiceOptions } from "../src/intel/service.ts";
import type { Portfolio, PortfolioProject } from "../src/shared/types.ts";
import { project, tempDir } from "./helpers.ts";
import { meetingFixture } from "./meeting-fixtures.ts";

export type ItemRow = { id: string; recordingId: string; kind?: string; text: string; quote?: string; role?: string; project?: string; due?: string | null; status?: string; feature?: object | null; strength?: "firm" | "tentative" | null; strengthSource?: "model" | "rule" | "user" | null };

/** Isolated temp-dir database with a fake portfolio and fake meetings. Never touches real projects. */
export function intelHarness(projects: { id: string; name: string; extra?: Partial<PortfolioProject> }[] = [{ id: "p1", name: "Acme" }], hooks: Pick<IntelServiceOptions, "workEvidence" | "onRecommendations"> = {}) {
  const home = tempDir("dave-intel-");
  const db: Db = openDb(home);
  let clock = new Date("2026-10-12T09:00:00.000Z");
  const state = { projects: projects.map((p) => project({ id: p.id, name: p.name, canonicalPath: `/work/${p.id}`, ...p.extra })), scan: true as boolean };
  for (const p of state.projects) db.prepare("INSERT INTO projects VALUES(?,?,?,?,?)").run(p.id, p.canonicalPath, p.name, "2026-01-01", "2026-01-01");
  const latest = (): Portfolio | null => state.scan ? { generatedAt: clock.toISOString(), active: state.projects, other: [], hidden: [], today: [], inbox: [], issues: [] } : null;
  const intel: IntelService = intelService(db, { latest, now: () => clock, ...hooks });
  const meetings = meetingStore(db);
  const seen = new Set<string>();
  const api = {
    home, db, intel, meetings, state,
    setNow: (iso: string) => { clock = new Date(iso); },
    addMeeting(recordingId: string, projectId = "p1", startedAt = "2026-10-08T10:00:00.000Z", title = `Call ${recordingId}`) {
      meetings.upsertMeeting(meetingFixture(recordingId, { title, startedAt, createdAt: startedAt }), startedAt);
      meetings.setMeetingProject(recordingId, projectId, "user", startedAt);
    },
    addItem(r: ItemRow) {
      if (!seen.has(r.recordingId)) { api.addMeeting(r.recordingId, r.project ?? "p1"); seen.add(r.recordingId); }
      db.prepare(`INSERT INTO meeting_items(id, recording_id, kind, text, quote, at_seconds, speaker, speaker_role, project_id, due_date, status, feature_json, strength, strength_source, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(r.id, r.recordingId, r.kind ?? "commitment", r.text, r.quote ?? r.text, 5, "Someone", r.role ?? "me", r.project ?? "p1",
        r.due ?? null, r.status ?? "open", r.feature ? JSON.stringify(r.feature) : null,
        // Firm by default (as the model would store it); pass null for a legacy row classified on read.
        r.strength === undefined ? "firm" : r.strength, r.strength === null ? null : r.strengthSource ?? "model",
        "2026-10-08T11:00:00.000Z", "2026-10-08T11:00:00.000Z");
    },
    snapshot: () => JSON.stringify({
      items: db.prepare("SELECT * FROM intel_items ORDER BY id").all(), proposals: db.prepare("SELECT * FROM intel_proposals ORDER BY id").all(),
      changes: db.prepare("SELECT * FROM intel_changes ORDER BY seq").all(), outcomes: db.prepare("SELECT * FROM intel_outcomes").all(),
    }),
    close() { db.close(); fs.rmSync(home, { recursive: true, force: true }); },
  };
  return api;
}
