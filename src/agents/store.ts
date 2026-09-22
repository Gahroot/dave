import { randomUUID } from "node:crypto";
import type { Db } from "../db/index.ts";
import { AgentError, clean, parseChecks, strings, text, type AgentRun, type AgentSettings, type RunEvent, type RunStatus } from "./types.ts";

type Row = Record<string, string | number | null>;
export function agentStore(db: Db) {
  function transaction<T>(fn: () => T): T { db.exec("BEGIN IMMEDIATE"); try { const r = fn(); db.exec("COMMIT"); return r; } catch(e) { db.exec("ROLLBACK"); throw e; } }
  function read(id: string): AgentRun {
    const r = db.prepare("SELECT r.*,p.name AS project_name,p.canonical_path AS project_path FROM agent_runs r JOIN projects p ON p.id=r.project_id WHERE r.id=?").get(id) as Row | undefined;
    if (!r) throw new AgentError(404, "Run not found");
    return { id: String(r.id), projectId: String(r.project_id), projectName: String(r.project_name), projectPath: String(r.project_path), title: String(r.title), prompt: String(r.prompt), criteria: JSON.parse(String(r.criteria_json)), checks: JSON.parse(String(r.checks_json)), dependencies: (db.prepare("SELECT depends_on FROM agent_dependencies WHERE run_id=?").all(id) as { depends_on: string }[]).map(v => v.depends_on), handoffId: r.handoff_id as string | null,
      status: r.status as RunStatus, revision: Number(r.revision), workspace: r.workspace as string | null, branch: String(r.branch), base: r.base as string | null, sessionId: r.session_id as string | null, turn: Number(r.turn), nextPrompt: String(r.next_prompt), permission: r.permission_json ? JSON.parse(String(r.permission_json)) : null, packet: r.packet_json ? JSON.parse(String(r.packet_json)) : null, reason: String(r.reason), createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
  }
  function event(id: string, kind: string, value: string) {
    if (kind === "output") {
      const { n, bytes } = db.prepare("SELECT COUNT(*) AS n,COALESCE(SUM(length(text)),0) AS bytes FROM agent_events WHERE run_id=? AND kind='output'").get(id) as { n: number; bytes: number };
      if (n >= 2000 || bytes >= 1_000_000) {
        if (!db.prepare("SELECT 1 FROM agent_events WHERE run_id=? AND kind='output-limit'").get(id)) event(id, "output-limit", "Output retention limit reached. Agent stopped; inspect the retained workspace and split the assignment before continuing.");
        return false;
      }
    }
    db.prepare("INSERT INTO agent_events(run_id,kind,text,created_at) VALUES(?,?,?,?)").run(id, kind, clean(value), new Date().toISOString());
    return true;
  }
  function patch(id: string, changes: Partial<Pick<AgentRun, "status" | "workspace" | "base" | "sessionId" | "turn" | "nextPrompt" | "permission" | "packet" | "reason">>) {
    const columns = { status: "status", workspace: "workspace", base: "base", sessionId: "session_id", turn: "turn", nextPrompt: "next_prompt", permission: "permission_json", packet: "packet_json", reason: "reason" };
    const entries = Object.entries(changes) as [keyof typeof columns, unknown][];
    const values = entries.map(([k,v]) => k === "permission" || k === "packet" ? v === null ? null : JSON.stringify(v) : v as string | number | null);
    db.exec("SAVEPOINT agent_patch");
    try {
      db.prepare(`UPDATE agent_runs SET ${entries.map(([k]) => `${columns[k]}=?`).join(",")},revision=revision+1,updated_at=? WHERE id=?`).run(...values, new Date().toISOString(), id);
      if (changes.packet) {
        const count = db.prepare("SELECT COUNT(*) AS n FROM agent_packets WHERE run_id=?").get(id) as { n: number };
        if (count.n >= 200) throw new AgentError(409, "Evidence history limit reached; create a new assignment");
        db.prepare("INSERT INTO agent_packets(run_id,turn,fingerprint,packet_json,created_at) VALUES(?,?,?,?,?)").run(id, read(id).turn, changes.packet.fingerprint, JSON.stringify(changes.packet), new Date().toISOString());
      }
      if (changes.status) event(id, "status", `${changes.status}${changes.reason ? `: ${changes.reason}` : ""}`);
      const result = read(id); db.exec("RELEASE agent_patch"); return result;
    } catch(e) { db.exec("ROLLBACK TO agent_patch; RELEASE agent_patch"); throw e; }
  }
  function guard(id: string, revision: unknown, allowed: RunStatus[]) {
    const r = read(id);
    if (revision !== r.revision || !allowed.includes(r.status)) throw new AgentError(409, "Run changed; reload before acting");
    return r;
  }
  function settings(): AgentSettings {
    const r = db.prepare("SELECT * FROM agent_settings WHERE id=1").get() as Row;
    return { enabled: !!r.enabled, paused: !!r.paused, maxConcurrent: Number(r.max_concurrent), maxPerProject: Number(r.max_per_project), reviewLimit: Number(r.review_limit), timeoutMinutes: Number(r.timeout_minutes) };
  }
  function list(): AgentRun[] {
    return (db.prepare("SELECT id FROM agent_runs ORDER BY CASE status WHEN 'waiting' THEN 0 WHEN 'interrupted' THEN 1 WHEN 'failed' THEN 2 WHEN 'review' THEN 3 WHEN 'queued' THEN 4 WHEN 'starting' THEN 4 WHEN 'running' THEN 4 WHEN 'checking' THEN 4 ELSE 5 END, created_at DESC LIMIT 200").all() as { id: string }[]).map(r => read(r.id));
  }
  return { read, event, patch, guard, transaction, settings, list,
    previous(key: string) { const row = db.prepare("SELECT id FROM agent_runs WHERE request_key=?").get(key) as { id: string } | undefined; return row ? read(row.id) : null; },
    projects: () => db.prepare("SELECT p.id,p.name FROM projects p LEFT JOIN project_overrides o ON o.project_id=p.id WHERE COALESCE(o.hidden,0)=0 ORDER BY p.name").all() as { id: string; name: string }[],
    events(id: string, after = 0): RunEvent[] { read(id); return db.prepare("SELECT seq,kind,text,created_at AS createdAt FROM agent_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 200").all(id, after) as RunEvent[]; },
    history(id: string) { read(id); return db.prepare("SELECT id,turn,fingerprint,created_at AS createdAt FROM agent_packets WHERE run_id=? ORDER BY id DESC LIMIT 200").all(id) as { id: number; turn: number; fingerprint: string; createdAt: string }[]; },
    evidence(id: string, packetId: number) {
      read(id);
      const row = db.prepare("SELECT packet_json FROM agent_packets WHERE run_id=? AND id=?").get(id, packetId) as { packet_json: string } | undefined;
      if (!row) throw new AgentError(404, "Evidence packet not found");
      return JSON.parse(row.packet_json) as NonNullable<AgentRun["packet"]>;
    },
    configure(v: Record<string, unknown>) {
      if (typeof v.enabled !== "boolean" || typeof v.paused !== "boolean" || (v.enabled && !settings().enabled && v.acknowledgeRisk !== true)) throw new AgentError(400, "Acknowledge local agent execution risk first");
      const nums = [v.maxConcurrent, v.maxPerProject, v.reviewLimit, v.timeoutMinutes];
      if (nums.some((n,i) => !Number.isInteger(n) || Number(n) < 1 || Number(n) > [6,3,12,120][i]!)) throw new AgentError(400, "Invalid scheduler limits");
      db.prepare("UPDATE agent_settings SET enabled=?,paused=?,max_concurrent=?,max_per_project=?,review_limit=?,timeout_minutes=? WHERE id=1").run(Number(v.enabled), Number(v.paused), ...nums as number[]);
      return settings();
    },
    enqueue(v: Record<string, unknown>) {
      if (v.authorizeExecution !== true) throw new AgentError(400, "Authorize this assignment and its checks before queueing");
      const projectId = text(v.projectId, 200), key = text(v.requestKey, 128), title = text(v.title, 200), prompt = text(v.prompt, 24000);
      const criteria = strings(v.criteria), checks = parseChecks(v.checks ?? []), dependencies = [...new Set(strings(v.dependencies ?? [], 12))];
      if (!criteria.length) throw new AgentError(400, "Supply at least one acceptance criterion");
      const handoffId = v.handoffId == null ? null : text(v.handoffId, 200);
      const request = JSON.stringify({ projectId, title, prompt, criteria, checks, dependencies, handoffId });
      return transaction(() => {
        const old = db.prepare("SELECT id,request_json FROM agent_runs WHERE request_key=?").get(key) as { id: string; request_json: string } | undefined;
        if (old) { if (old.request_json !== request) throw new AgentError(409, "Request key already used"); return read(old.id); }
        if (!settings().enabled) throw new AgentError(409, "Enable execution before queueing work");
        if (!this.projects().some(p => p.id === projectId)) throw new AgentError(404, "Project unavailable");
        if (handoffId && db.prepare("SELECT 1 FROM agent_runs WHERE handoff_id=?").get(handoffId)) throw new AgentError(409, "This handoff already has a run");
        const n = (db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE status NOT IN ('accepted','stopped')").get() as { n: number }).n;
        if (n >= 100) throw new AgentError(409, "Resolve existing work before queueing more");
        dependencies.forEach(read); // Existing-only edges cannot introduce a cycle.
        const id = randomUUID(), now = new Date().toISOString();
        db.prepare("INSERT INTO agent_runs(id,project_id,request_key,request_json,title,prompt,criteria_json,checks_json,handoff_id,status,branch,next_prompt,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'queued',?,?,?,?)")
          .run(id, projectId, key, request, title, prompt, JSON.stringify(criteria), JSON.stringify(checks), handoffId, `dave/${id}`, prompt, now, now);
        for (const d of dependencies) db.prepare("INSERT INTO agent_dependencies(run_id,depends_on) VALUES(?,?)").run(id, d);
        event(id, "queued", "Assignment queued; no work has been accepted.");
        return read(id);
      });
    },
    review(id: string, action: "accept" | "return", reason: string) {
      const r = read(id);
      db.prepare("INSERT INTO agent_reviews(run_id,action,fingerprint,reason,created_at) VALUES(?,?,?,?,?)").run(id, action, r.packet?.fingerprint ?? "", reason, new Date().toISOString());
      event(id, "review", `${action}: ${reason}`);
    },
    recover() {
      for (const r of list().filter(r => ["starting","running","waiting","checking"].includes(r.status))) patch(r.id, { status: "interrupted", permission: null, reason: "Server restarted. Inspect the workspace and confirm old agents have stopped before retrying." });
      // Never resume a queue automatically on server startup.
      db.prepare("UPDATE agent_settings SET paused=1 WHERE id=1").run();
    },
  };
}
export type AgentStore = ReturnType<typeof agentStore>;
