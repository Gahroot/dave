import { createHash, randomUUID } from "node:crypto";
import type { Db } from "./index.ts";
import type { CompletionReport, DeliveryEvent, DeliveryGoal, DeliveryPlanDraft, DeliveryState, MilestoneDefinition } from "../model/delivery-schema.ts";

export class DeliveryError extends Error {
  readonly code: "invalid" | "not-found" | "conflict";
  readonly state?: DeliveryState;
  constructor(code: DeliveryError["code"], message: string, state?: DeliveryState) {
    super(message);
    this.code = code;
    this.state = state;
    this.name = "DeliveryError";
  }
}
function requireValue(valid: boolean, message: string): asserts valid {
  if (!valid) throw new DeliveryError("invalid", message);
}
function text(value: unknown, max: number): asserts value is string {
  requireValue(typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0"), "Invalid or oversized text");
}
function keys(value: unknown, allowed: string[]): void {
  requireValue(typeof value === "object" && value !== null && !Array.isArray(value), "Expected an object");
  requireValue(Object.keys(value).length === allowed.length && Object.keys(value).every((k) => allowed.includes(k)), "Unexpected or missing fields");
}
function strings(value: unknown, min = 0, max = 12, length = 2000): void {
  requireValue(Array.isArray(value) && value.length >= min && value.length <= max, "Invalid list size");
  for (const item of value) text(item, length);
}
function validateGoal(goal: DeliveryGoal): void {
  keys(goal, ["goal", "intendedUser", "workflow", "stage", "provider", "model", "consent"]);
  text(goal.goal, 4000); text(goal.intendedUser, 1000); text(goal.workflow, 4000); text(goal.stage, 1000);
  requireValue((goal.provider === null && goal.model === null) ||
    (goal.provider === "openai" && goal.model === "gpt-6-astra") ||
    (goal.provider === "claude" && ["claude-fable-5-1", "claude-opus-5"].includes(goal.model ?? "")), "Unsupported planning provider/model");
  if (goal.consent !== null) {
    keys(goal.consent, ["fingerprint", "categories"]);
    text(goal.consent.fingerprint, 128);
    strings(goal.consent.categories, 1, 12, 80);
    requireValue(goal.provider !== null, "Consent requires a selected provider");
  }
}
function validatePlan(plan: DeliveryPlanDraft): void {
  keys(plan, ["assumptions", "milestones"]);
  strings(plan.assumptions);
  requireValue(Array.isArray(plan.milestones) && plan.milestones.length >= 3 && plan.milestones.length <= 6, "A plan needs 3–6 milestones");
  const titles = new Set<string>();
  plan.milestones.forEach((m, position) => {
    keys(m, ["title", "outcome", "whyNow", "scope", "exclusions", "acceptance", "sourceIds", "humanPrerequisites", "dependencies"]);
    text(m.title, 200); text(m.outcome, 2000); text(m.whyNow, 2000);
    strings(m.scope, 1); strings(m.exclusions); strings(m.acceptance, 2, 6);
    strings(m.sourceIds, 0, 24, 128); strings(m.humanPrerequisites);
    requireValue(!titles.has(m.title.trim().toLowerCase()), "Duplicate milestone title");
    titles.add(m.title.trim().toLowerCase());
    requireValue(Array.isArray(m.dependencies) && m.dependencies.length <= position &&
      new Set(m.dependencies).size === m.dependencies.length &&
      m.dependencies.every((d) => Number.isSafeInteger(d) && d >= 0 && d < position), "Dependencies must reference earlier milestones");
  });
  requireValue(JSON.stringify(plan).length <= 64000, "Plan is too large");
}

/** Only Dave's database is accepted. No filesystem discovery, provider calls or
 * credentials. BEGIN IMMEDIATE serializes read/check/write across connections;
 * immutable events and completion keys survive process restarts.
 */
export function deliveryRepo(db: Db, clock = () => new Date()) {
  const q = {
    project: db.prepare("SELECT id FROM projects WHERE id = ?"),
    state: db.prepare("SELECT * FROM delivery_state WHERE project_id = ?"),
    plans: db.prepare("SELECT * FROM delivery_plans WHERE project_id = ? ORDER BY revision"),
    milestones: db.prepare("SELECT * FROM delivery_milestones WHERE project_id = ? AND plan_id = ? ORDER BY position"),
    events: db.prepare("SELECT * FROM delivery_events WHERE project_id = ? ORDER BY revision"),
    nextPlans: db.prepare("SELECT revision,status,error FROM delivery_next_plan WHERE project_id = ? ORDER BY revision"),
    duplicate: db.prepare("SELECT request_hash FROM delivery_events WHERE project_id = ? AND idempotency_key = ?"),
    init: db.prepare("INSERT INTO delivery_state(project_id,updated_at) VALUES (?,?) ON CONFLICT(project_id) DO NOTHING"),
    advance: db.prepare("UPDATE delivery_state SET revision = revision + 1, current_plan_id = ?, current_milestone_id = ?, updated_at = ? WHERE project_id = ? AND revision = ?"),
    goal: db.prepare("UPDATE delivery_state SET goal_json = ? WHERE project_id = ?"),
    plan: db.prepare("INSERT INTO delivery_plans(id,project_id,revision,goal_json,assumptions_json,created_at) VALUES (?,?,?,?,?,?)"),
    milestone: db.prepare("INSERT INTO delivery_milestones(id,project_id,plan_id,position,definition_json,status) VALUES (?,?,?,?,?,'pending')"),
    dependency: db.prepare("INSERT INTO delivery_dependencies(project_id,plan_id,position,dependency_position) VALUES (?,?,?,?)"),
    status: db.prepare("UPDATE delivery_milestones SET status = ?, blocked_reason = ?, completed_at = ? WHERE project_id = ? AND plan_id = ? AND id = ?"),
    event: db.prepare("INSERT INTO delivery_events(id,project_id,revision,kind,plan_id,milestone_id,detail_json,source,idempotency_key,request_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"),
    next: db.prepare("INSERT INTO delivery_next_plan(project_id,revision,completion_id,status) VALUES (?,?,?,'pending')"),
    supersede: db.prepare("UPDATE delivery_next_plan SET status = 'superseded', error = NULL WHERE project_id = ? AND status != 'superseded'"),
    failNext: db.prepare("UPDATE delivery_next_plan SET status = 'error', error = ? WHERE project_id = ? AND revision = ? AND status = 'pending'"),
    retryNext: db.prepare("UPDATE delivery_next_plan SET status = 'pending', error = NULL WHERE project_id = ? AND revision = ? AND status = 'error'"),
  };
  function transaction<T>(fn: () => T, write = true): T {
    db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  // simplification: return complete local history for dozens of revisions;
  // add cursor pagination before projects accumulate thousands of revisions.
  function read(projectId: string): DeliveryState {
    text(projectId, 128);
    if (!q.project.get(projectId)) throw new DeliveryError("not-found", "Unknown project");
    const row = q.state.get(projectId) as { revision: number; goal_json: string | null; current_plan_id: string | null; current_milestone_id: string | null } | undefined;
    const plans = (q.plans.all(projectId) as { id: string; revision: number; goal_json: string; assumptions_json: string; created_at: string }[]).map((p) => ({
      id: p.id, revision: p.revision, goal: JSON.parse(p.goal_json) as DeliveryGoal,
      assumptions: JSON.parse(p.assumptions_json) as string[], createdAt: p.created_at,
      milestones: (q.milestones.all(projectId, p.id) as { id: string; position: number; definition_json: string; status: "pending" | "blocked" | "reported-complete"; blocked_reason: string | null; completed_at: string | null }[])
        .map((m) => ({ ...JSON.parse(m.definition_json) as MilestoneDefinition, id: m.id, position: m.position, status: m.status, blockedReason: m.blocked_reason, completedAt: m.completed_at })),
    }));
    const history = (q.events.all(projectId) as { id: string; revision: number; kind: DeliveryEvent["kind"]; plan_id: string | null; milestone_id: string | null; detail_json: string; source: DeliveryEvent["source"]; created_at: string }[])
      .map((e) => ({ id: e.id, revision: e.revision, kind: e.kind, planId: e.plan_id, milestoneId: e.milestone_id, detail: JSON.parse(e.detail_json) as DeliveryEvent["detail"], source: e.source, createdAt: e.created_at }));
    return { projectId, revision: row?.revision ?? 0, goal: row?.goal_json ? JSON.parse(row.goal_json) as DeliveryGoal : null,
      currentPlanId: row?.current_plan_id ?? null, currentMilestoneId: row?.current_milestone_id ?? null,
      plans, history, nextPlans: q.nextPlans.all(projectId) as DeliveryState["nextPlans"] };
  }
  function expected(projectId: string, revision: number): DeliveryState {
    requireValue(Number.isSafeInteger(revision) && revision >= 0, "Invalid revision");
    const state = read(projectId);
    if (state.revision !== revision) throw new DeliveryError("conflict", "Delivery state changed", state);
    q.init.run(projectId, clock().toISOString());
    return state;
  }
  function event(state: DeliveryState, kind: DeliveryEvent["kind"], detail: DeliveryEvent["detail"], planId = state.currentPlanId,
    milestoneId = state.currentMilestoneId, key: string | null = null, hash: string | null = null): string {
    const id = randomUUID(), at = clock().toISOString();
    const changed = q.advance.run(planId, milestoneId, at, state.projectId, state.revision);
    if (changed.changes !== 1) throw new DeliveryError("conflict", "Delivery state changed", read(state.projectId));
    q.event.run(id, state.projectId, state.revision + 1, kind, state.currentPlanId, state.currentMilestoneId,
      JSON.stringify(detail), kind === "complete" ? "user-reported" : "user-requested", key, hash, at);
    return id;
  }
  function current(state: DeliveryState, milestoneId: string) {
    if (state.currentMilestoneId !== milestoneId) throw new DeliveryError("conflict", "Not the current milestone", state);
    const plan = state.plans.find((p) => p.id === state.currentPlanId);
    const milestone = plan?.milestones.find((m) => m.id === milestoneId);
    if (!plan || !milestone) throw new DeliveryError("not-found", "Unknown milestone");
    return { plan, milestone };
  }
  function eligible(plan: DeliveryState["plans"][number]): string | null {
    return plan.milestones.find((m) => m.status !== "reported-complete" &&
      m.dependencies.every((d) => plan.milestones[d]?.status === "reported-complete"))?.id ?? null;
  }
  return {
    read: (projectId: string) => transaction(() => read(projectId), false),
    saveGoal(projectId: string, revision: number, goal: DeliveryGoal): DeliveryState {
      validateGoal(goal);
      return transaction(() => {
        const state = expected(projectId, revision);
        q.goal.run(JSON.stringify(goal), projectId);
        q.supersede.run(projectId);
        event(state, "goal", goal);
        return read(projectId);
      });
    },
    savePlan(projectId: string, revision: number, plan: DeliveryPlanDraft, authorizeSave?: () => void): DeliveryState {
      validatePlan(plan);
      return transaction(() => {
        const state = expected(projectId, revision);
        requireValue(state.goal !== null, "Save a project goal first");
        // Server-internal guard participates in this transaction, including operation success.
        authorizeSave?.();
        const planId = randomUUID(), ids = plan.milestones.map(() => randomUUID());
        q.plan.run(planId, projectId, revision + 1, JSON.stringify(state.goal), JSON.stringify(plan.assumptions), clock().toISOString());
        plan.milestones.forEach((m, position) => {
          q.milestone.run(ids[position]!, projectId, planId, position, JSON.stringify(m));
          for (const d of m.dependencies) q.dependency.run(projectId, planId, position, d);
        });
        q.supersede.run(projectId);
        event({ ...state, currentPlanId: planId, currentMilestoneId: ids[0]! }, "plan", { planId });
        return read(projectId);
      });
    },
    complete(projectId: string, revision: number, milestoneId: string, key: string, report: CompletionReport): { state: DeliveryState; duplicate: boolean } {
      text(key, 128); text(milestoneId, 128);
      keys(report, ["outcome", "evidence"]); text(report.outcome, 4000); text(report.evidence, 8000);
      const hash = createHash("sha256").update(JSON.stringify([revision, milestoneId, report.outcome, report.evidence])).digest("hex");
      return transaction(() => {
        const previous = q.duplicate.get(projectId, key) as { request_hash: string } | undefined;
        if (previous) {
          const state = read(projectId);
          if (previous.request_hash !== hash) throw new DeliveryError("conflict", "Completion key was already used for a different report", state);
          return { state, duplicate: true };
        }
        const state = expected(projectId, revision), { plan, milestone } = current(state, milestoneId);
        requireValue(milestone.status === "pending", "Reopen a blocked milestone before completing it");
        requireValue(milestone.dependencies.every((d) => plan.milestones[d]?.status === "reported-complete"), "Milestone dependencies are incomplete");
        q.status.run("reported-complete", null, clock().toISOString(), projectId, plan.id, milestoneId);
        const updated = read(projectId).plans.find((p) => p.id === plan.id)!;
        const next = eligible(updated);
        const completion = event(state, "complete", report, plan.id, next, key, hash);
        if (updated.milestones.every((m) => m.status === "reported-complete")) q.next.run(projectId, revision + 1, completion);
        return { state: read(projectId), duplicate: false };
      });
    },
    block(projectId: string, revision: number, milestoneId: string, reason: string): DeliveryState {
      text(reason, 2000);
      return transaction(() => {
        const state = expected(projectId, revision), { plan } = current(state, milestoneId);
        q.status.run("blocked", reason, null, projectId, plan.id, milestoneId);
        event(state, "block", { reason });
        return read(projectId);
      });
    },
    reopen(projectId: string, revision: number, milestoneId: string, reason: string): DeliveryState {
      text(reason, 2000);
      return transaction(() => {
        const state = expected(projectId, revision);
        const plan = state.plans.find((p) => p.milestones.some((m) => m.id === milestoneId));
        const milestone = plan?.milestones.find((m) => m.id === milestoneId);
        if (!plan || !milestone) throw new DeliveryError("not-found", "Unknown milestone");
        requireValue(milestone.status !== "pending", "Milestone is already pending");
        requireValue(milestone.dependencies.every((d) => plan.milestones[d]?.status === "reported-complete"), "Milestone dependencies are incomplete");
        q.status.run("pending", null, null, projectId, plan.id, milestoneId);
        q.supersede.run(projectId);
        event({ ...state, currentPlanId: plan.id, currentMilestoneId: milestoneId }, "reopen", { reason }, plan.id, milestoneId);
        return read(projectId);
      });
    },
    /** Record/retry generation failure separately: never complete a milestone twice. */
    nextPlanFailure(projectId: string, revision: number, message: string): DeliveryState {
      text(message, 2000);
      return transaction(() => {
        const state = expected(projectId, revision);
        requireValue(q.failNext.run(message, projectId, revision).changes === 1, "No pending continuation");
        return { ...state, nextPlans: read(projectId).nextPlans };
      });
    },
    retryNextPlan(projectId: string, revision: number): DeliveryState {
      return transaction(() => {
        expected(projectId, revision);
        requireValue(q.retryNext.run(projectId, revision).changes === 1, "No failed continuation");
        return read(projectId);
      });
    },
  };
}
