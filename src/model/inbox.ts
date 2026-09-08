import { createHash } from "node:crypto";
import type { AttentionCandidate, PortfolioProject } from "../shared/types.ts";
import type { SessionSummary } from "../adapters/session-summary.ts";
import type { Repo } from "../db/repo.ts";
import { classifyTask } from "../attention/today.ts";

export type InboxInput = {
  project: PortfolioProject;
  sessions: SessionSummary[];
  /** False on failed reads: absence is then not evidence of resolution. */
  observed?: boolean;
};

export function attentionCandidates(inputs: InboxInput[]): AttentionCandidate[] {
  return inputs.flatMap(({ project: p }) => {
    if (p.override.hidden || !p.exists) return [];
    return p.tasks.flatMap((t) => {
      const attention = classifyTask(t);
      if (!attention) return [];
      return [{
        projectId: p.id,
        subjectKey: JSON.stringify([t.source, t.id]),
        fingerprint: createHash("sha256").update(JSON.stringify([t.source, t.id, t.status, attention.request])).digest("hex"),
        legacyDedupeKey: `agent-question:${t.id}`,
        kind: attention.kind,
        title: attention.kind === "agent-question" ? `${p.name}: an agent is waiting on you` : `${p.name}: inspect a reported blocker`,
        detail: attention.request,
        evidence: [{ kind: t.source.startsWith("ezboss") ? "ezboss-task" as const : "ezcoder-task" as const,
          path: t.source.startsWith("/") ? t.source : null,
          detail: `Inferred from task text: ${attention.request}`, observedAt: t.updatedAt ?? "" }],
        urgency: attention.urgency,
        nextStep: attention.nextStep,
      }];
    });
  });
}

export function generateInbox(inputs: InboxInput[], repo: Repo, now = new Date(), baseline = false): void {
  repo.reconcileAttention(attentionCandidates(inputs),
    inputs.filter((i) => i.observed !== false && i.project.exists && !i.project.override.hidden).map((i) => i.project.id),
    now.toISOString(), baseline);
}
