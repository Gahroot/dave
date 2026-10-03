import { Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";
import { Hand, OctagonAlert, TriangleAlert } from "lucide-react";
import type { DeliveryHandoff, EvidenceResult } from "../../../model/delivery-coordination.ts";
import { summarizeReview } from "../../delivery-review-model.ts";
import { StatusIcon, StatusMark } from "../../components/Status.tsx";
import { CHECK_RESULT, CRITERION_REPORTED, type StatusSpec } from "../../status.ts";

const BLOCKER: StatusSpec = { tone: "red", icon: OctagonAlert, label: "Blocker" };
const RISK: StatusSpec = { tone: "amber", icon: TriangleAlert, label: "Risk" };
const PREREQUISITE: StatusSpec = { tone: "amber", icon: Hand, label: "Unresolved prerequisite" };
const criterionSpec = (status: EvidenceResult["criteria"][number]["status"]) => CRITERION_REPORTED[status === "unmet" ? "failed" : status];
const commandSpec = (exitCode: number | null) => CHECK_RESULT[exitCode === null ? "not-run" : exitCode === 0 ? "passed" : "failed"];

/** What the coding tool reported. Every line here is a claim, so "met" stays gray: nobody independent checked it. */
export function ReviewEvidence({ report, handoff, prerequisites, children }: {
  report: EvidenceResult; handoff: DeliveryHandoff | undefined; prerequisites: string[]; children: ReactNode;
}): ReactNode {
  const summary = summarizeReview(report);
  const criterion = (c: EvidenceResult["criteria"][number]) => { const spec = criterionSpec(c.status); return <li key={c.id} className="result-row"><StatusIcon spec={spec} /><span className="result-row-title">{handoff?.criteria.find(h => h.id === c.id)?.text ?? c.id}</span><span className="result-row-detail"><strong>{spec.label}.</strong> <span className="review-prose">{c.evidence}</span></span></li>; };
  const command = (c: EvidenceResult["commands"][number], index: number) => { const spec = commandSpec(c.exitCode); return <li key={index} className="result-row"><StatusIcon spec={spec} /><code className="result-row-title command-line">{c.command}</code><span className="result-row-detail"><strong>{c.exitCode === null ? "Not run" : `${spec.label} · exit ${c.exitCode}`}.</strong> <span className="review-prose">{c.evidence}</span></span></li>; };
  const flagged = (spec: StatusSpec, text: string, key: string) => <li key={key} className="result-row"><StatusIcon spec={spec} /><span className="result-row-title review-prose">{text}</span><span className="result-row-detail">{spec.label}</span></li>;
  const problems = [
    ...report.blockers.map((text, i) => flagged(BLOCKER, text, `blocker-${i}`)),
    ...report.criteria.filter(c => c.status !== "met").map(criterion),
    ...report.commands.filter(c => c.exitCode !== 0).map(command),
    ...report.risks.map((text, i) => flagged(RISK, text, `risk-${i}`)),
    ...prerequisites.map((text, i) => flagged(PREREQUISITE, text, `prerequisite-${i}`)),
  ];
  return <Stack gap="sm" className="review-evidence">
    <Text component="div" className="review-prose">{report.outcome.length > 400 ? <>{report.outcome.slice(0, 400)}…<details className="quiet-details"><summary>Full reported outcome</summary>{report.outcome}</details></> : report.outcome}</Text>
    <div className="status-line evidence-tally" role="group" aria-label="Reported evidence">
      <StatusMark spec={CRITERION_REPORTED.met}>{summary.criteria.met} of {report.criteria.length} criteria reported met</StatusMark>
      {!!summary.criteria.failed && <StatusMark spec={CRITERION_REPORTED.failed}>{summary.criteria.failed} reported failed</StatusMark>}
      {!!summary.criteria.unknown && <StatusMark spec={CRITERION_REPORTED.unknown}>{summary.criteria.unknown} unknown</StatusMark>}
      {report.commands.length ? <>
        {!!summary.commands.passed && <StatusMark spec={CHECK_RESULT.passed}>{summary.commands.passed} commands passed</StatusMark>}
        {!!summary.commands.failed && <StatusMark spec={CHECK_RESULT.failed}>{summary.commands.failed} failed</StatusMark>}
        {!!summary.commands.notRun && <StatusMark spec={CHECK_RESULT["not-run"]}>{summary.commands.notRun} not run</StatusMark>}
      </> : <StatusMark spec={CHECK_RESULT["not-run"]}>No commands reported</StatusMark>}
    </div>
    <Text size="xs" c="dimmed">Reported by your coding tool. Nobody independent has checked it.</Text>
    {!summary.canAccept && <Text fw={600} className="blocking-line"><StatusIcon spec={CHECK_RESULT.failed} /> Acceptance unavailable: resolve failed, unknown or not-run results and reported blockers.</Text>}
    {problems.length > 0 && <ul className="result-list" aria-label="Needs your attention">{problems}</ul>}
    {!report.risks.length && <Text size="sm" c="dimmed">No risks reported.</Text>}
    {children}
    <details className="quiet-details"><summary>All criteria and evidence ({report.criteria.length})</summary><ul className="result-list">{report.criteria.map(criterion)}</ul></details>
    <details className="quiet-details"><summary>Commands and evidence ({report.commands.length})</summary><ul className="result-list">{report.commands.map(command)}{!report.commands.length && <li className="result-row"><StatusIcon spec={CHECK_RESULT["not-run"]} /><span className="result-row-title">No commands reported.</span></li>}</ul></details>
  </Stack>;
}
