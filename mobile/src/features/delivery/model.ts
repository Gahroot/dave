/**
 * Pure delivery helpers for the phone (no React Native imports). Mirrors the
 * constants and wording of src/ui/sections/DeliveryView.tsx,
 * DeliveryCoordination.tsx and src/ui/delivery-api.ts.
 */
import type { DeliveryGoal, DeliveryPlan, DeliveryState } from "../../../../src/model/delivery-schema.ts";
import type { ContextCategory } from "../../../../src/model/delivery-context.ts";

/**
 * Mirror of GenerationOperation in src/model/delivery-planner.ts, which pulls
 * server-only provider modules into type checking; keep the fields in sync.
 */
export type GenerationOperation = { id: string; project_id: string; revision: number; fingerprint: string; purpose: string; status: "pending" | "success" | "error" | "cancelled"; error: string | null; deadline: number; created_at: string };

export const INITIAL_GOAL: DeliveryGoal = { goal: "Daily usability", intendedUser: "", workflow: "", stage: "", provider: null, model: null, consent: null };

/** Same order as the web; the server validates the set (src/model/delivery-context.ts CONTEXT_CATEGORIES). */
export const CONTEXT_CATEGORIES: readonly ContextCategory[] = ["goal", "documents", "manifest", "entrypoints", "coverage", "history", "meetings"];

export function categoryLabel(category: ContextCategory): string {
  return category === "goal" ? "Goal (required)" : category === "meetings" ? "meetings: open promises, client pain points and decisions (DAVE's summary, no transcripts)" : category;
}

export const CONTEXT_DOCUMENTS: readonly string[] = ["README.md", "PRODUCT.md", "SCOPE.md", "BRIEF.md", "SPEC.md", "ARCHITECTURE.md", "docs/PRODUCT.md", "docs/ARCHITECTURE.md"];

export const GOAL_FIELDS = [
  { key: "goal", label: "What are you trying to build", maxLength: 4000 },
  { key: "intendedUser", label: "Who uses it", maxLength: 1000 },
  { key: "workflow", label: "What they do with it day to day", maxLength: 4000 },
  { key: "stage", label: "Where it is now, and what you are unsure about", maxLength: 1000 },
] as const satisfies readonly { key: keyof DeliveryGoal; label: string; maxLength: number }[];

export function modelOptions(provider: DeliveryGoal["provider"]): string[] {
  return provider === "openai" ? ["gpt-6-astra"] : provider === "claude" ? ["claude-fable-5-1", "claude-opus-5"] : [];
}

export function goalComplete(goal: DeliveryGoal): boolean {
  return !!goal.goal.trim() && !!goal.intendedUser.trim() && !!goal.workflow.trim() && !!goal.stage.trim() && (!goal.provider || !!goal.model);
}

/** The web delivery-api message: server text plus what to do next. */
export function deliveryErrorMessage(body: unknown, status: number, url: string): string {
  let text = "Request failed";
  if (typeof body === "object" && body !== null) {
    const record = body as { message?: unknown; error?: unknown };
    if (typeof record.message === "string") text = record.message;
    else if (typeof record.error === "string") text = record.error;
  }
  const next = status === 409 ? "Reload latest saved state; your draft is retained. Review it before retrying."
    : url.startsWith("/api/agents") ? "Your draft is retained. Review the run or retry when ready."
    : "Your draft is retained. Check Connections or retry when ready.";
  return `${text}. ${next}`;
}

/** The `state` a failed delivery write returns, when it looks like one. */
export function stateFromBody(body: unknown): DeliveryState | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const state: unknown = (body as { state?: unknown }).state;
  if (typeof state !== "object" || state === null) return undefined;
  const candidate = state as { revision?: unknown; plans?: unknown; history?: unknown };
  return typeof candidate.revision === "number" && Array.isArray(candidate.plans) && Array.isArray(candidate.history) ? state as DeliveryState : undefined;
}

/** Pretty JSON for review, or "" while the paste is incomplete. */
export function prettyJson(text: string): string {
  if (!text.trim()) return "";
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return ""; }
}

export type DestinationOption = { value: string; label: string };
export const UNMAPPED = "none";
export function destinationOptions(plan: DeliveryPlan | undefined): DestinationOption[] {
  const count = plan?.milestones.length ?? 3;
  return Array.from({ length: count }, (_, i) => {
    const title = plan?.milestones[i]?.title;
    return { value: String(i), label: `Milestone ${i + 1}${title ? `: ${title}` : ""}` };
  });
}
export function destinationValue(milestones: readonly number[]): string {
  const first = milestones[0];
  return first === undefined ? UNMAPPED : String(first);
}
export function destinationFrom(value: string): number[] {
  return value === UNMAPPED ? [] : [Number(value)];
}

/** RFC 4122 v4 idempotency key from the platform CSPRNG (installed by lib/polyfills). */
export function randomKey(random: (bytes: Uint8Array<ArrayBuffer>) => void = (b) => { globalThis.crypto.getRandomValues(b); }): string {
  const bytes = new Uint8Array(16);
  random(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function truncate(text: string, max: number): { short: string; truncated: boolean } {
  return text.length > max ? { short: `${text.slice(0, max)}…`, truncated: true } : { short: text, truncated: false };
}
