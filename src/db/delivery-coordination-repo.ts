import { createHash, randomUUID } from "node:crypto";
import type { Db } from "./index.ts";
import { deliveryRepo, DeliveryError } from "./delivery-repo.ts";
import { coordinationText, parseEvidenceResult, parseFinishContract, type CoordinationState, type DeliveryHandoff } from "../model/delivery-coordination.ts";
import { deriveDeliveryProgress, reportFailures, semanticGoal } from "../model/delivery-progress.ts";
import { buildDeliveryQueue, WIP_LIMIT, type QueueInput } from "../model/delivery-queue.ts";
import { parseDeliveryPlan, type DeliveryState } from "../model/delivery-schema.ts";
import { contextTextSafe } from "../model/delivery-context.ts";

const hashGoal = (state: DeliveryState) => createHash("sha256").update(semanticGoal(state.goal)).digest("hex");
export function deliveryCoordinationRepo(db: Db) {
  const base = deliveryRepo(db);
  const invalid = (message: string): never => { throw new DeliveryError("invalid", message); };
  function read(state: DeliveryState): CoordinationState {
    const row = db.prepare("SELECT * FROM delivery_contracts WHERE project_id=? AND active=1").get(state.projectId) as { id: string; goal_hash: string; definition_json: string; resolutions_json: string } | undefined;
    return {
      contract: row ? { ...parseFinishContract(JSON.parse(row.definition_json)), id: row.id, goalHash: row.goal_hash } : null,
      goalMatches: !row || row.goal_hash === hashGoal(state),
      resolutions: row ? JSON.parse(row.resolutions_json) as Record<string, string> : {},
      handoffs: (db.prepare("SELECT id,plan_id,milestone_id,contract_id,criteria_json,created_at FROM delivery_handoffs WHERE project_id=? AND active=1 ORDER BY rowid").all(state.projectId) as { id: string; plan_id: string; milestone_id: string; contract_id: string; criteria_json: string; created_at: string | null }[]).map(h => ({ id: h.id, planId: h.plan_id, milestoneId: h.milestone_id, contractId: h.contract_id, criteria: JSON.parse(h.criteria_json) as DeliveryHandoff["criteria"], createdAt: h.created_at })),
      reports: (db.prepare("SELECT id,handoff_id,report_json,created_at FROM delivery_reports WHERE project_id=? ORDER BY rowid").all(state.projectId) as { id: string; handoff_id: string; report_json: string; created_at: string }[]).map(r => ({ id: r.id, handoffId: r.handoff_id, report: JSON.parse(r.report_json), createdAt: r.created_at })),
      decisions: (db.prepare("SELECT id,milestone_id,report_id,action,reason,created_at FROM delivery_reviews WHERE project_id=? ORDER BY rowid").all(state.projectId) as { id: string; milestone_id: string; report_id: string | null; action: "accept" | "return"; reason: string; created_at: string }[]).map(d => ({ id: d.id, milestoneId: d.milestone_id, reportId: d.report_id, action: d.action, reason: d.reason, createdAt: d.created_at })),
      engagement: (db.prepare("SELECT state FROM delivery_engagements WHERE project_id=?").get(state.projectId) as { state: "active" | "paused" } | undefined)?.state ?? null,
    };
  }
  function snapshot(projectId: string) {
    db.exec("BEGIN");
    try { const state = base.readInTransaction(projectId), value = { state, coordination: read(state) }; db.exec("COMMIT"); return value; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function change(projectId: string, revision: number, fn: (state: DeliveryState, data: CoordinationState) => void, duplicate?: () => boolean) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const state = base.readInTransaction(projectId);
      if (!duplicate?.()) {
      if (!Number.isSafeInteger(revision) || revision !== state.revision) throw new DeliveryError("conflict", "Delivery state changed; reload and review your retained draft", state);
      if ((db.prepare("SELECT hidden FROM project_overrides WHERE project_id=?").get(projectId) as { hidden: number } | undefined)?.hidden) invalid("Unhide the project before coordinating work");
      db.prepare("INSERT INTO delivery_state(project_id,updated_at) VALUES (?,?) ON CONFLICT(project_id) DO NOTHING").run(projectId, new Date().toISOString());
      fn(state, read(state));
      db.prepare("UPDATE delivery_state SET revision=revision+1,updated_at=? WHERE project_id=?").run(new Date().toISOString(), projectId);
      db.prepare("UPDATE delivery_next_plan SET status='superseded',error=NULL WHERE project_id=? AND status!='superseded'").run(projectId);
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return snapshot(projectId);
  }
  /** Records what was assigned and when, so silence becomes measurable. */
  function issue(state: DeliveryState, data: CoordinationState, milestone: { id: string; position: number; acceptance: string[] }) {
    const contract = data.contract!;
    const criteria = milestone.acceptance.map((text, i) => ({ id: `m${i}`, text }));
    contract.criteria.forEach((c, i) => { if (c.milestones.includes(milestone.position)) criteria.push({ id: `c${i}`, text: c.text }); });
    db.prepare("INSERT INTO delivery_handoffs(id,project_id,plan_id,milestone_id,contract_id,criteria_json,created_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), state.projectId, state.currentPlanId!, milestone.id, contract.id, JSON.stringify(criteria), new Date().toISOString());
  }
  function invalidate(state: DeliveryState, milestoneId?: string) {
    const plan = state.plans.find(p => p.id === state.currentPlanId);
    const positions = new Set<number>();
    for (const m of plan?.milestones ?? []) {
      if (!milestoneId || m.id === milestoneId || m.dependencies.some(d => positions.has(d))) {
        positions.add(m.position);
        db.prepare("UPDATE delivery_handoffs SET active=0 WHERE project_id=? AND milestone_id=? AND active=1").run(state.projectId, m.id);
        db.prepare("UPDATE delivery_milestones SET status='pending',blocked_reason=NULL,completed_at=NULL WHERE project_id=? AND id=?").run(state.projectId, m.id);
      }
    }
  }
  return {
    read: snapshot,
    /**
     * Taking on work is capped, and the cap is the point: three at a time is what makes
     * the fourth get finished instead of started. Pausing is always allowed.
     */
    engage(projectId: string, revision: number, next: "active" | "paused") { return change(projectId, revision, () => {
      if (next !== "active" && next !== "paused") invalid("Unknown engagement state");
      if (next === "active") {
        const active = (db.prepare("SELECT COUNT(*) AS n FROM delivery_engagements WHERE state='active' AND project_id!=?").get(projectId) as { n: number }).n;
        if (active >= WIP_LIMIT) invalid(`You already have ${WIP_LIMIT} projects on the go. Pause one before starting another.`);
      }
      db.prepare("INSERT INTO delivery_engagements(project_id,state,started_at) VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET state=excluded.state").run(projectId, next, new Date().toISOString());
    }); },
    /** One deterministic next action per engaged project; no model call, no heuristics. */
    queue() {
      const rows = db.prepare("SELECT e.project_id AS projectId,e.state,e.started_at AS startedAt,p.name AS projectName FROM delivery_engagements e JOIN projects p ON p.id=e.project_id LEFT JOIN project_overrides o ON o.project_id=e.project_id WHERE COALESCE(o.hidden,0)=0").all() as { projectId: string; state: "active" | "paused"; startedAt: string; projectName: string }[];
      // One unreadable project must never hide the rest of your delivery list.
      return buildDeliveryQueue(rows.map((row): QueueInput => {
        try { const { state, coordination } = snapshot(row.projectId); return { ...row, delivery: state, coordination }; }
        catch { return { ...row, unreadable: true }; }
      }));
    },
    saveContract(projectId: string, revision: number, value: unknown) {
      const contract = parseFinishContract(value);
      return change(projectId, revision, state => {
        if (!state.goal) invalid("Save a delivery goal first");
        invalidate(state);
        db.prepare("UPDATE delivery_contracts SET active=0 WHERE project_id=? AND active=1").run(projectId);
        db.prepare("INSERT INTO delivery_contracts(id,project_id,goal_hash,definition_json) VALUES (?,?,?,?)").run(randomUUID(), projectId, hashGoal(state), JSON.stringify(contract));
      });
    },
    saveManualPlan(projectId: string, revision: number, raw: string) {
      if (!contextTextSafe(raw)) invalid("Plan contains unsafe text");
      const draft = parseDeliveryPlan(raw, []);
      base.savePlan(projectId, revision, draft, () => {
        const row = db.prepare("SELECT goal_hash FROM delivery_contracts WHERE project_id=? AND active=1").get(projectId) as { goal_hash: string } | undefined;
        if (!row || row.goal_hash !== hashGoal(base.readInTransaction(projectId))) invalid("Save a current finish contract first");
        if ((db.prepare("SELECT hidden FROM project_overrides WHERE project_id=?").get(projectId) as { hidden: number } | undefined)?.hidden) invalid("Unhide the project first");
      });
      return snapshot(projectId);
    },
    resolve(projectId: string, revision: number, prerequisiteId: string, evidence: string) {
      coordinationText(evidence);
      return change(projectId, revision, (state, data) => {
        const index = Number(prerequisiteId.slice(1));
        if (!/^p\d+$/.test(prerequisiteId) || !data.contract?.prerequisites[index] || !data.goalMatches) invalid("Unknown or stale prerequisite");
        db.prepare("UPDATE delivery_contracts SET resolutions_json=? WHERE project_id=? AND active=1").run(JSON.stringify({ ...data.resolutions, [prerequisiteId]: evidence }), state.projectId);
      });
    },
    handoff(projectId: string, revision: number, milestoneId: string) {
      return change(projectId, revision, (state, data) => {
        const progress = deriveDeliveryProgress(state, data), item = progress.milestones.find(m => m.milestone.id === milestoneId);
        if (!item || progress.stale || !["ready", "handed-off"].includes(item.status)) invalid("Milestone is not eligible for a handoff");
        if (item!.handoff) return;
        issue(state, data, item!.milestone);
      });
    },
    /**
     * For work that was sent off and never came back. It is not a retry of rejected
     * work, so it deliberately does not count towards the three-strikes limit: nothing
     * was ever delivered to reject. Cancelling is always offered beside it, and each
     * send restarts a two-day clock, so this cannot spin without a person choosing it.
     */
    resend(projectId: string, revision: number, milestoneId: string, reason: string) {
      coordinationText(reason);
      return change(projectId, revision, (state, data) => {
        const progress = deriveDeliveryProgress(state, data), item = progress.milestones.find(m => m.milestone.id === milestoneId);
        if (!item || progress.stale || item.status !== "handed-off" || item.report) invalid("Only work that was sent off and never came back can be sent again");
        db.prepare("UPDATE delivery_handoffs SET active=0 WHERE project_id=? AND milestone_id=? AND active=1").run(projectId, milestoneId);
        db.prepare("INSERT INTO delivery_reviews(id,project_id,plan_id,milestone_id,report_id,action,reason,created_at) VALUES (?,?,?,?,NULL,'return',?,?)").run(randomUUID(), projectId, state.currentPlanId!, milestoneId, reason, new Date().toISOString());
        issue(state, data, item!.milestone);
      });
    },
    submit(projectId: string, revision: number, key: string, value: unknown) {
      coordinationText(key, 128);
      const report = parseEvidenceResult(value), serialized = JSON.stringify(report);
      if (report.projectId !== projectId) invalid("Result belongs to another project");
      return change(projectId, revision, (state, data) => {
        const progress = deriveDeliveryProgress(state, data), item = progress.milestones.find(m => m.milestone.id === report.milestoneId);
        const handoff = item?.handoff;
        if (!item || !handoff || handoff.id !== report.handoffId || report.planId !== state.currentPlanId || !["handed-off", "needs-review"].includes(item.status) || progress.stale) invalid("Result assignment is stale, blocked or belongs to another plan");
        if (report.criteria.length !== handoff!.criteria.length || report.criteria.some(c => !handoff!.criteria.some(h => h.id === c.id))) invalid("Result must cover every assigned criterion exactly once");
        db.prepare("INSERT INTO delivery_reports(id,project_id,handoff_id,idempotency_key,report_json,created_at) VALUES (?,?,?,?,?,?)").run(randomUUID(), projectId, report.handoffId, key, serialized, new Date().toISOString());
      }, () => {
        // Deduplication and revision validation share the same writer transaction.
        const previous = db.prepare("SELECT report_json FROM delivery_reports WHERE project_id=? AND idempotency_key=?").get(projectId, key) as { report_json: string } | undefined;
        if (previous && previous.report_json !== serialized) throw new DeliveryError("conflict", "Result key already used for different content");
        return !!previous;
      });
    },
    review(projectId: string, revision: number, milestoneId: string, action: "accept" | "return", reason: string) {
      coordinationText(reason);
      if (action !== "accept" && action !== "return") invalid("Unknown review action");
      return change(projectId, revision, (state, data) => {
        const progress = deriveDeliveryProgress(state, data), item = progress.milestones.find(m => m.milestone.id === milestoneId);
        if (!item) invalid("Unknown milestone");
        if (action === "accept") {
          if (item!.status !== "needs-review" || !item!.report || reportFailures(item!.report.report).length || progress.stale) invalid("Acceptance requires current, complete passing evidence and resolved prerequisites");
          db.prepare("UPDATE delivery_milestones SET status='reported-complete',blocked_reason=NULL,completed_at=? WHERE project_id=? AND id=?").run(new Date().toISOString(), projectId, milestoneId);
        } else invalidate(state, milestoneId);
        db.prepare("INSERT INTO delivery_reviews(id,project_id,plan_id,milestone_id,report_id,action,reason,created_at) VALUES (?,?,?,?,?,?,?,?)").run(randomUUID(), projectId, state.currentPlanId!, milestoneId, item!.report?.id ?? null, action, reason, new Date().toISOString());
      });
    },
    block(projectId: string, revision: number, milestoneId: string, reason: string) {
      coordinationText(reason);
      return change(projectId, revision, (state) => {
        if (!state.plans.find(p => p.id === state.currentPlanId)?.milestones.some(m => m.id === milestoneId)) invalid("Unknown milestone");
        invalidate(state, milestoneId);
        db.prepare("UPDATE delivery_milestones SET status='blocked',blocked_reason=? WHERE project_id=? AND id=?").run(reason, projectId, milestoneId);
        db.prepare("INSERT INTO delivery_reviews(id,project_id,plan_id,milestone_id,report_id,action,reason,created_at) VALUES (?,?,?,?,NULL,'return',?,?)").run(randomUUID(), projectId, state.currentPlanId!, milestoneId, reason, new Date().toISOString());
      });
    },
  };
}
