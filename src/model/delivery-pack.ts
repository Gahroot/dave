import type { CoordinationState } from "./delivery-coordination.ts";
import type { DeliveryState } from "./delivery-schema.ts";
import { contextTextSafe } from "./delivery-context.ts";
import { deriveDeliveryProgress } from "./delivery-progress.ts";

export class PackError extends Error {}

const MAX_PACK_BYTES = 128_000;

/**
 * Everything here came from a coding tool or was typed by hand, so it is quoted as
 * reported rather than presented as fact, and anything carrying a secret shape is
 * dropped outright rather than shipped to a client.
 */
function safe(text: string): string {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) return "";
  return contextTextSafe(value) ? value : "[Removed: this text looked like it contained a credential.]";
}
const bullet = (items: string[]) => items.filter(Boolean).map(t => `- ${t}`).join("\n");

/**
 * The finish line, rendered only from rows that already exist: no model call, no
 * network, no inference. Nothing counts as proven unless the user accepted it, so a
 * returned or still-unreviewed report contributes nothing but its risks.
 */
export function deliveryPack(input: { projectName: string; state: DeliveryState; coordination: CoordinationState; now?: Date }): string {
  const { state, coordination } = input;
  const contract = coordination.contract;
  if (!contract) throw new PackError("Set out what finished means before making a delivery pack");
  const progress = deriveDeliveryProgress(state, coordination);
  if (progress.stale) throw new PackError("The goal changed after this was agreed; review the finish line before making a delivery pack");

  const name = safe(input.projectName) || "This project";
  const generatedAt = (input.now ?? new Date()).toISOString();
  const sections: string[] = [
    `# ${name}: what was delivered`,
    `Prepared ${generatedAt.slice(0, 10)}. Everything below is quoted from what was reported and what you accepted; nothing was re-run to produce this document.`,
    `## What was promised\n\n${safe(contract.outcome)}`,
  ];

  // Only accepted milestones can prove anything: acceptance is the user's own signature.
  const accepted = progress.milestones.filter(m => m.accepted && m.report);
  const acceptedReports = new Set(accepted.map(m => m.report!.id));

  const proven = progress.criteria.map(c => {
    const evidence = accepted.flatMap(m => m.report!.report.criteria
      .filter(r => r.status === "met" && (m.handoff?.criteria.find(h => h.id === r.id)?.text ?? "") === c.text)
      .map(r => safe(r.evidence)));
    return c.accepted && evidence.length
      ? `### ${safe(c.text)}\n\nDone. Reported as: ${evidence.join(" ")}`
      : `### ${safe(c.text)}\n\n${c.accepted ? "Accepted, but no evidence was quoted for it." : "Not delivered."}`;
  });
  sections.push(`## What was promised, one by one\n\n${proven.join("\n\n")}`);

  const commands = accepted.flatMap(m => m.report!.report.commands.map(c =>
    `${safe(c.command)} — ${c.exitCode === null ? "not run" : `exit ${c.exitCode}`}${safe(c.evidence) ? `. ${safe(c.evidence)}` : ""}`));
  sections.push(`## Checks that were run\n\n${commands.length ? bullet(commands) : "No commands were reported for the accepted work."}`);

  const excluded = contract.exclusions.map(safe).filter(Boolean);
  sections.push(`## Not included\n\n${excluded.length ? bullet(excluded) : "Nothing was written down as out of scope."}`);

  // Risks survive the report that carried them, including ones attached to work that
  // was returned or decided on after three tries: a known risk does not stop being real.
  const risks = coordination.reports.flatMap(r => r.report.risks.map(safe)).filter(Boolean);
  const decided = coordination.decisions.filter(d => d.action === "return" && !acceptedReports.has(d.reportId ?? "")).map(d => safe(d.reason)).filter(Boolean);
  const outstanding = progress.milestones.filter(m => !m.accepted).map(m => `${safe(m.milestone.title)}: not delivered`);
  sections.push(`## Known risks and what is still open\n\n${bullet([...new Set([...risks, ...decided, ...outstanding])]) || "Nothing was flagged, which is not the same as nothing being wrong."}`);

  const resolved = contract.prerequisites.map((p, i) => {
    const evidence = coordination.resolutions[`p${i}`];
    return `${safe(p.owner)}: ${safe(p.text)} — ${evidence ? `sorted. ${safe(evidence)}` : "still outstanding"}`;
  });
  sections.push(`## What was needed from other people\n\n${resolved.length ? bullet(resolved) : "Nothing was needed from anyone outside the work."}`);

  sections.push(`## How to read this\n\nDone here means you read the reported evidence and accepted it. No independent party has verified it and the client has not signed anything off.`);

  const text = sections.join("\n\n");
  if (Buffer.byteLength(text) > MAX_PACK_BYTES) throw new PackError("This delivery pack is too large to hand over; trim the reported evidence first");
  return text;
}
