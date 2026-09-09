/** Storage domain types and strict, untrusted inference-output boundary. */
export type DeliveryGoal = {
  goal: string;
  intendedUser: string;
  workflow: string;
  stage: string;
  provider: "openai" | "claude" | null;
  model: string | null;
  consent: { fingerprint: string; categories: string[] } | null;
};

export type MilestoneDefinition = {
  title: string;
  outcome: string;
  whyNow: string;
  scope: string[];
  exclusions: string[];
  acceptance: string[];
  sourceIds: string[];
  humanPrerequisites: string[];
  /** Zero-based positions in this plan; dependencies must precede this milestone. */
  dependencies: number[];
};
export type DeliveryPlanDraft = { assumptions: string[]; milestones: MilestoneDefinition[] };

export const MAX_PLAN_BYTES = 64000;
export class PlanOutputError extends Error {
  constructor() { super("Invalid milestone JSON; provide the exact bounded capability schema"); }
}
/** No coercion, markdown extraction, unknown fields, forward references or model IDs. */
export function parseDeliveryPlan(raw: string, allowedSourceIds: readonly string[]): DeliveryPlanDraft {
  const fail = (): never => { throw new PlanOutputError(); };
  if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_PLAN_BYTES) fail();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return fail(); }
  const object = (v: unknown, fields: string[]): Record<string, unknown> => {
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== fields.length || Object.keys(v).some(k => !fields.includes(k))) return fail();
    return v as Record<string, unknown>;
  };
  const text = (v: unknown, max: number): string => {
    if (typeof v !== "string" || !v.trim() || v.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]|<\|(?:im_start|im_end|system|assistant)|```|<\/?(?:system|assistant|tool_call)\b/i.test(v)) return fail();
    return v;
  };
  const list = (v: unknown, min = 0, max = 12, length = 2000): string[] => {
    if (!Array.isArray(v) || v.length < min || v.length > max) return fail();
    const result = v.map(x => text(x, length));
    if (new Set(result.map(x => x.trim().toLowerCase())).size !== result.length) fail();
    return result;
  };
  const root = object(value, ["assumptions", "milestones"]);
  const assumptions = list(root.assumptions);
  if (!Array.isArray(root.milestones) || root.milestones.length < 3 || root.milestones.length > 6) return fail();
  const titles = new Set<string>(), outcomes = new Set<string>();
  const milestones = root.milestones.map((v, position): MilestoneDefinition => {
    const m = object(v, ["title", "outcome", "whyNow", "scope", "exclusions", "acceptance", "sourceIds", "humanPrerequisites", "dependencies"]);
    const title = text(m.title, 200), outcome = text(m.outcome, 2000);
    // A heuristic, not a claim to prove semantic quality. Verification belongs inside scope.
    const microtask = /^(?:(?:just|only)\s+)?(?:commit\b|push\b|run\s+(?:the\s+)?tests?\b|(?:write|add|create)\s+(?:(?:a|one|single|unit|sample|example)\s+)*(?:test|example|plan|document)\b|enumerate\s+tasks\b)/i;
    if (microtask.test(title.trim()) || microtask.test(outcome.trim())) fail();
    for (const [set, s] of [[titles, title], [outcomes, outcome]] as const) {
      const normalized = s.trim().toLowerCase();
      if (set.has(normalized)) fail();
      set.add(normalized);
    }
    const sourceIds = list(m.sourceIds, 0, 24, 128);
    if (sourceIds.some(id => !allowedSourceIds.includes(id))) fail();
    if (!Array.isArray(m.dependencies) || m.dependencies.length > position || new Set(m.dependencies).size !== m.dependencies.length || m.dependencies.some(d => !Number.isSafeInteger(d) || d < 0 || d >= position)) return fail();
    return { title, outcome, whyNow: text(m.whyNow, 2000), scope: list(m.scope, 1), exclusions: list(m.exclusions), acceptance: list(m.acceptance, 2, 6), sourceIds, humanPrerequisites: list(m.humanPrerequisites), dependencies: m.dependencies as number[] };
  });
  return { assumptions, milestones };
}
export type CompletionReport = { outcome: string; evidence: string };
export type DeliveryMilestone = MilestoneDefinition & {
  id: string;
  position: number;
  status: "pending" | "blocked" | "reported-complete";
  blockedReason: string | null;
  completedAt: string | null;
};
export type DeliveryPlan = {
  id: string;
  revision: number;
  goal: DeliveryGoal;
  assumptions: string[];
  createdAt: string;
  milestones: DeliveryMilestone[];
};
export type DeliveryEvent = {
  id: string;
  revision: number;
  kind: "goal" | "plan" | "complete" | "block" | "reopen";
  planId: string | null;
  milestoneId: string | null;
  detail: DeliveryGoal | CompletionReport | { reason: string } | { planId: string };
  source: "user-reported" | "user-requested";
  createdAt: string;
};
export type DeliveryState = {
  projectId: string;
  revision: number;
  goal: DeliveryGoal | null;
  currentPlanId: string | null;
  currentMilestoneId: string | null;
  plans: DeliveryPlan[];
  history: DeliveryEvent[];
  nextPlans: { revision: number; status: "pending" | "error" | "superseded"; error: string | null }[];
};
