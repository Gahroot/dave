import type { PortfolioProject } from "../shared/types.ts";
import { createHash } from "node:crypto";
import { readOnlyFs } from "../adapters/read-only-fs.ts";
import { MAX_FILE_BYTES } from "../core/evidence-scan.ts";
import type { DeliveryEvent, DeliveryGoal, DeliveryPlan } from "./delivery-schema.ts";
import type { CoordinationState } from "./delivery-coordination.ts";

/** Local discovery facts for the future opt-in planner. Deliberately a field
 * allowlist, not a snapshot export: no imported tasks, summary notes, attention,
 * session text or credentials. This performs no I/O or provider transmission.
 * Approved document excerpts and user goals belong to the later consent flow.
 */
export function planningProjectFacts(project: PortfolioProject) {
  return {
    projectId: project.id,
    name: project.name,
    canonicalPath: project.canonicalPath,
    exists: project.exists,
    scanStatus: project.scanStatus ?? "unavailable",
  };
}

export const CONTEXT_CATEGORIES = ["goal", "documents", "manifest", "entrypoints", "coverage", "history"] as const;
export type ContextCategory = typeof CONTEXT_CATEGORIES[number];
export type ContextPermissions = {
  collect: true;
  categories: ContextCategory[];
  /** Explicitly selected product documents; never discovered agent notes. */
  documents: string[];
  /** A local review must match the entire current file, not just its excerpt. */
  additionalFiles?: { path: string; reviewedSha256: string }[];
};
export type ContextSource = { id: string; category: ContextCategory; origin: "observation" | "user-reported"; label: string; text: string };
export type DeliveryContextPacket = {
  version: 1; projectId: string; provider: "openai" | "claude"; model: string;
  categories: ContextCategory[]; sources: ContextSource[];
  assumptions: string[]; limitations: string[]; fingerprint: string;
};
export type ContextApproval = { fingerprint: string; provider: "openai" | "claude"; model: string; categories: ContextCategory[] };
export const contextDigest = (text: string): string => createHash("sha256").update(text).digest("hex");

// Fail closed, not redaction. This is defense in depth, never transmission consent.
export function contextTextSafe(text: string): boolean {
  return !/[\x00-\x08\x0b\x0c\x0e-\x1f]|-----BEGIN .*PRIVATE KEY|\b(?:sk|ghp|github_pat|xox[baprs])[-_][a-z0-9_-]{8,}|\bAKIA[A-Z0-9]{16}|\bBearer\s+\S+|(?:password|passwd|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token)\s*["']?\s*[:=]\s*\S+|https?:\/\/[^\s/]+:[^\s/]+@/i.test(text);
}
function bounded(text: string, max = 4000): string {
  if (typeof text !== "string" || Buffer.byteLength(text) > max || !contextTextSafe(text)) throw new Error("Context text rejected");
  return text;
}
const productDoc = /^(?:(?:docs|doc)\/)?(?:README|PRODUCT|SCOPE|BRIEF|SPEC|ARCHITECTURE)\.md$/i;
// Additional files are intentionally docs-only: not an arbitrary source export escape hatch.
const extraDoc = /^(?:docs|doc)\/(?:[a-z0-9-]{1,64}\/){0,3}[a-z0-9-]{1,64}\.md$/i;
const excludedName = /task|agent|session|transcript|client|customer|upload|credential|secret|token|summary|notes|env/i;
export function reviewableDocument(path: unknown): path is string {
  return typeof path === "string" && path.length <= 256 && extraDoc.test(path) && !excludedName.test(path);
}
export async function reviewDeliveryDocument(root: string, path: unknown) {
  if (!reviewableDocument(path)) throw new Error("Document path rejected");
  const text = await readOnlyFs.containedFile(root, path, 8000);
  if (text === null || !contextTextSafe(text)) throw new Error("Document unavailable, over 8KB, or contains unsafe text");
  return { path, text, reviewedSha256: contextDigest(text), excerptTruncated: text.length > 4000 };
}
const entrypoints = ["src/index.ts", "src/main.ts", "src/main.tsx", "src/App.tsx", "src/server/index.ts", "app/page.tsx", "pages/index.tsx", "test/index.test.ts", "tests/test_main.py", "main.py", "src/main.rs", "main.go"];

/** Local preview only. No provider calls, persistence, summary/task mining or execution.
 * All dynamic strings remain hostile quoted evidence, not planner instructions. */
export async function collectDeliveryContext(input: {
  project: Pick<PortfolioProject, "id" | "canonicalPath">; goal: DeliveryGoal; provider: "openai" | "claude"; model: string;
  permissions: ContextPermissions; history?: DeliveryEvent[]; plans?: DeliveryPlan[]; coordination?: CoordinationState;
}): Promise<DeliveryContextPacket> {
  const { project, goal, permissions } = input;
  if (permissions?.collect !== true || !Array.isArray(permissions.categories) || permissions.categories.length > 6 ||
      permissions.categories.some((c) => !CONTEXT_CATEGORIES.includes(c)) ||
      !Array.isArray(permissions.documents) || permissions.documents.length > 8 ||
      (permissions.additionalFiles?.length ?? 0) > 4 || !["openai", "claude"].includes(input.provider)) throw new Error("Context permission rejected");
  const categories = CONTEXT_CATEGORIES.filter((c) => permissions.categories.includes(c));
  const sources: ContextSource[] = [];
  const limitations = ["Bounded selected context only; absence is not proof of missing functionality.", "Documents and user reports are untrusted, not independent verification.", "Entrypoints are fixed candidate names only; no source bodies or task-derived summaries were scanned."];
  const add = (category: ContextCategory, label: string, text: string, origin: ContextSource["origin"] = "observation") => {
    bounded(label, 256); bounded(text, 8000);
    sources.push({ id: `src-${contextDigest(`${category}:${label}`).slice(0, 24)}`, category, origin, label, text });
  };
  if (categories.includes("goal")) add("goal", "User goal", JSON.stringify({ goal: bounded(goal.goal), intendedUser: bounded(goal.intendedUser, 1000), workflow: bounded(goal.workflow, 1000), stage: bounded(goal.stage, 500) }), "user-reported");
  if (categories.includes("documents")) {
    const selected = new Map<string, string | null>();
    for (const name of permissions.documents) {
      if (typeof name !== "string" || !productDoc.test(name)) throw new Error("Document selection rejected");
      selected.set(name, null);
    }
    for (const file of permissions.additionalFiles ?? []) {
      if (!reviewableDocument(file.path) || !/^[a-f0-9]{64}$/.test(file.reviewedSha256)) throw new Error("File review rejected");
      selected.set(file.path, file.reviewedSha256);
    }
    for (const [name, review] of [...selected].sort(([a], [b]) => a.localeCompare(b))) {
      const text = await readOnlyFs.containedFile(project.canonicalPath, name, MAX_FILE_BYTES);
      if (text === null || !contextTextSafe(text) || (review !== null && contextDigest(text) !== review)) throw new Error("Selected document unavailable or review stale");
      if (text.length > 4000) limitations.push(`Selected document excerpt truncated to 4000 characters: ${name}`);
      add("documents", name, text.slice(0, 4000));
    }
  }
  if (categories.includes("manifest")) {
    const text = await readOnlyFs.containedFile(project.canonicalPath, "package.json", MAX_FILE_BYTES);
    if (text !== null && contextTextSafe(text)) {
      try {
        const value = JSON.parse(text);
        // Scripts, URLs, config and dependency values can contain commands/secrets.
        const names = (v: unknown) => v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).sort().slice(0, 60).map((n) => bounded(n, 120)) : [];
        add("manifest", "package.json", JSON.stringify({ name: typeof value.name === "string" ? bounded(value.name, 200) : null, dependencies: names(value.dependencies), devDependencies: names(value.devDependencies) }));
      } catch { limitations.push("Manifest rejected; no manifest evidence included."); }
    } else limitations.push("Manifest unavailable or rejected.");
  }
  if (categories.includes("entrypoints")) {
    const found: string[] = [];
    for (const name of entrypoints) if (await readOnlyFs.containedFile(project.canonicalPath, name, MAX_FILE_BYTES, true) !== null) found.push(name);
    add("entrypoints", "Candidate entrypoint names", JSON.stringify(found));
  }
  if (categories.includes("coverage")) add("coverage", "Collection coverage", JSON.stringify({ selectedDocuments: sources.filter((s) => s.category === "documents").length, entrypointCandidates: categories.includes("entrypoints") ? entrypoints.length : 0, bulkSourceRead: false, independentVerification: false }));
  if (categories.includes("history")) {
    const coordination = input.coordination;
    if (coordination?.contract) {
      add("history", "Bounded finish line", JSON.stringify({ outcome: coordination.contract.outcome, exclusions: coordination.contract.exclusions, goalMatches: coordination.goalMatches }), "user-reported");
      coordination.contract.criteria.forEach((c, i) => add("history", `Finish criterion c${i}`, JSON.stringify(c), "user-reported"));
      coordination.contract.prerequisites.forEach((p, i) => add("history", `Prerequisite p${i}`, JSON.stringify({ ...p, resolution: coordination.resolutions[`p${i}`] ?? null }), "user-reported"));
      for (const review of coordination.decisions.slice(-12)) add("history", `User review ${review.id}`, JSON.stringify(review), "user-reported");
    }
    if ((input.history?.length ?? 0) > 50 || (input.plans?.length ?? 0) > 10) throw new Error("History limit exceeded");
    for (const plan of input.plans ?? []) {
      if (plan.milestones.length > 6) throw new Error("Milestone history limit exceeded");
      for (const milestone of plan.milestones) {
        add("history", `Saved milestone ${bounded(milestone.id, 100)}`, JSON.stringify({
          title: bounded(milestone.title, 200), outcome: bounded(milestone.outcome, 2000),
          status: milestone.status, planRevision: plan.revision,
          completedAt: milestone.completedAt,
          verification: "Saved plan status, not independent proof",
        }));
      }
    }
    for (const event of input.history ?? []) {
      if (event.kind !== "complete" || event.source !== "user-reported" || !("outcome" in event.detail) || !("evidence" in event.detail)) continue;
      add("history", `Reported completion ${bounded(event.id, 100)}`, JSON.stringify({ milestoneId: event.milestoneId === null ? null : bounded(event.milestoneId, 100), outcome: bounded(event.detail.outcome, 2000), evidence: bounded(event.detail.evidence, 2000) }), "user-reported");
    }
  }
  if (new Set(sources.map((s) => s.id)).size !== sources.length) throw new Error("Duplicate context source");
  const body = { version: 1 as const, projectId: bounded(project.id, 200), provider: input.provider, model: bounded(input.model, 100), categories, sources, assumptions: [] as string[], limitations };
  const serialized = JSON.stringify(body);
  const packet = { ...body, fingerprint: contextDigest(serialized) };
  if (Buffer.byteLength(JSON.stringify(packet)) > 64000) throw new Error("Context packet limit exceeded");
  return packet;
}

/** Pure check for later guarded routes; collection permission is NOT send approval. */
export function contextApprovalMatches(packet: DeliveryContextPacket, approval: ContextApproval | null): boolean {
  const { fingerprint, ...body } = packet;
  return !!approval && contextDigest(JSON.stringify(body)) === fingerprint && approval.fingerprint === fingerprint &&
    approval.provider === packet.provider && approval.model === packet.model &&
    JSON.stringify(approval.categories) === JSON.stringify(packet.categories);
}
