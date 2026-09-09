import { contextTextSafe } from "./delivery-context.ts";

export class CoordinationInputError extends Error {}

export type FinishContractDraft = {
  outcome: string;
  exclusions: string[];
  criteria: { text: string; milestones: number[] }[];
  prerequisites: { text: string; owner: string; milestones: number[] }[];
};
export type FinishContract = FinishContractDraft & { id: string; goalHash: string };
export type EvidenceResult = {
  version: 1; projectId: string; planId: string; milestoneId: string; handoffId: string;
  outcome: string;
  criteria: { id: string; status: "met" | "unmet" | "unknown"; evidence: string }[];
  commands: { command: string; exitCode: number | null; evidence: string }[];
  blockers: string[]; risks: string[];
};
export type DeliveryHandoff = {
  id: string; planId: string; milestoneId: string; contractId: string;
  criteria: { id: string; text: string }[];
};
export type CoordinationState = {
  contract: FinishContract | null;
  goalMatches: boolean;
  resolutions: Record<string, string>;
  handoffs: DeliveryHandoff[];
  reports: { id: string; handoffId: string; report: EvidenceResult; createdAt: string }[];
  decisions: { id: string; milestoneId: string; reportId: string | null; action: "accept" | "return"; reason: string; createdAt: string }[];
  focusProjectId: string | null;
};
export function coordinationText(value: unknown, max = 2000): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max || !contextTextSafe(value)) throw new CoordinationInputError("Invalid, unsafe or oversized text");
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(k => !keys.includes(k))) throw new CoordinationInputError("Unexpected or missing fields");
  return value as Record<string, unknown>;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new CoordinationInputError("Invalid list size");
  return value;
}
function texts(value: unknown): string[] { return list(value, 12).map(v => { coordinationText(v); return v; }); }
function positions(value: unknown): number[] {
  const items = list(value, 6);
  if (items.some(v => !Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > 5) || new Set(items).size !== items.length) throw new CoordinationInputError("Invalid milestone positions");
  return items as number[];
}
function bounded(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > 64000) throw new CoordinationInputError("Input exceeds 64KB");
}
export function parseFinishContract(value: unknown): FinishContractDraft {
  bounded(value);
  const root = object(value, ["outcome", "exclusions", "criteria", "prerequisites"]);
  coordinationText(root.outcome, 4000);
  const criteria = list(root.criteria, 12).map(v => {
    const c = object(v, ["text", "milestones"]); coordinationText(c.text);
    return { text: c.text, milestones: positions(c.milestones) };
  });
  if (criteria.length < 2 || new Set(criteria.map(c => c.text.trim().toLowerCase())).size !== criteria.length) throw new CoordinationInputError("Provide 2–12 distinct finish criteria");
  const prerequisites = list(root.prerequisites, 12).map(v => {
    const p = object(v, ["text", "owner", "milestones"]); coordinationText(p.text); coordinationText(p.owner, 200);
    return { text: p.text, owner: p.owner, milestones: positions(p.milestones) };
  });
  return { outcome: root.outcome, exclusions: texts(root.exclusions), criteria, prerequisites };
}
export function parseEvidenceResult(value: unknown): EvidenceResult {
  bounded(value);
  const root = object(value, ["version", "projectId", "planId", "milestoneId", "handoffId", "outcome", "criteria", "commands", "blockers", "risks"]);
  if (root.version !== 1) throw new CoordinationInputError("Unsupported result version");
  for (const key of ["projectId", "planId", "milestoneId", "handoffId"] as const) coordinationText(root[key], 128);
  coordinationText(root.outcome, 4000);
  const criteria = list(root.criteria, 18).map(v => {
    const c = object(v, ["id", "status", "evidence"]); coordinationText(c.id, 128); coordinationText(c.evidence, 4000);
    if (!["met", "unmet", "unknown"].includes(c.status as string)) throw new CoordinationInputError("Invalid criterion status");
    return { id: c.id, status: c.status as "met" | "unmet" | "unknown", evidence: c.evidence };
  });
  if (!criteria.length || new Set(criteria.map(c => c.id)).size !== criteria.length) throw new CoordinationInputError("Missing or duplicate criterion results");
  const commands = list(root.commands, 12).map(v => {
    const c = object(v, ["command", "exitCode", "evidence"]); coordinationText(c.command, 1000); coordinationText(c.evidence, 4000);
    if (c.exitCode !== null && (!Number.isSafeInteger(c.exitCode) || Math.abs(c.exitCode as number) > 2147483647)) throw new CoordinationInputError("Invalid exit status");
    return { command: c.command, exitCode: c.exitCode as number | null, evidence: c.evidence };
  });
  return { version: 1, projectId: root.projectId as string, planId: root.planId as string, milestoneId: root.milestoneId as string, handoffId: root.handoffId as string, outcome: root.outcome, criteria, commands, blockers: texts(root.blockers), risks: texts(root.risks) };
}
