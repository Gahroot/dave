/** Port of src/ui/sections/delivery/ReviewEvidence.tsx. Every line is a claim: "met" stays gray. */
import type { ReactNode } from "react";
import { Hand, OctagonAlert, TriangleAlert } from "lucide-react-native";
import type { DeliveryHandoff, EvidenceResult } from "../../../../src/model/delivery-coordination.ts";
import { summarizeReview } from "../../../../src/ui/delivery-review-model.ts";
import { CHECK_RESULT, CRITERION_REPORTED } from "../../../../src/ui/status.ts";
import { Body, Caption, Disclosure, Inline, Muted, Small, Stack } from "../../ui/primitives";
import { StatusMark, type StatusSpec } from "../../ui/status";
import { ResultRow } from "./StagePanels";
import { truncate } from "./model";

const BLOCKER: StatusSpec = { tone: "red", icon: OctagonAlert, label: "Blocker" };
const RISK: StatusSpec = { tone: "amber", icon: TriangleAlert, label: "Risk" };
const PREREQUISITE: StatusSpec = { tone: "amber", icon: Hand, label: "Unresolved prerequisite" };
type Criterion = EvidenceResult["criteria"][number];
type Command = EvidenceResult["commands"][number];
const criterionSpec = (status: Criterion["status"]) => CRITERION_REPORTED[status === "unmet" ? "failed" : status];
const commandSpec = (exitCode: number | null) => CHECK_RESULT[exitCode === null ? "not-run" : exitCode === 0 ? "passed" : "failed"];

export function ReviewEvidence({ report, handoff, prerequisites, children }: {
  report: EvidenceResult; handoff: DeliveryHandoff | undefined; prerequisites: string[]; children: ReactNode;
}) {
  const summary = summarizeReview(report);
  const criterion = (c: Criterion) => { const spec = criterionSpec(c.status); return <ResultRow key={`c-${c.id}`} spec={spec} title={handoff?.criteria.find((h) => h.id === c.id)?.text ?? c.id} detail={`${spec.label}. ${c.evidence}`} />; };
  const command = (c: Command, index: number) => { const spec = commandSpec(c.exitCode); return <ResultRow key={`cmd-${index}`} spec={spec} mono title={c.command} detail={`${c.exitCode === null ? "Not run" : `${spec.label} · exit ${c.exitCode}`}. ${c.evidence}`} />; };
  const flagged = (spec: StatusSpec, value: string, key: string) => <ResultRow key={key} spec={spec} title={value} detail={spec.label} />;
  const problems = [
    ...report.blockers.map((value, i) => flagged(BLOCKER, value, `blocker-${i}`)),
    ...report.criteria.filter((c) => c.status !== "met").map(criterion),
    ...report.commands.filter((c) => c.exitCode !== 0).map(command),
    ...report.risks.map((value, i) => flagged(RISK, value, `risk-${i}`)),
    ...prerequisites.map((value, i) => flagged(PREREQUISITE, value, `prerequisite-${i}`)),
  ];
  const outcome = truncate(report.outcome, 400);
  return <Stack gap={10}>
    <Body selectable>{outcome.short}</Body>
    {outcome.truncated && <Disclosure title="Full reported outcome"><Body selectable>{report.outcome}</Body></Disclosure>}
    <Inline>
      <StatusMark spec={CRITERION_REPORTED.met}>{summary.criteria.met} of {report.criteria.length} criteria reported met</StatusMark>
      {!!summary.criteria.failed && <StatusMark spec={CRITERION_REPORTED.failed}>{summary.criteria.failed} reported failed</StatusMark>}
      {!!summary.criteria.unknown && <StatusMark spec={CRITERION_REPORTED.unknown}>{summary.criteria.unknown} unknown</StatusMark>}
      {report.commands.length ? <>
        {!!summary.commands.passed && <StatusMark spec={CHECK_RESULT.passed}>{summary.commands.passed} commands passed</StatusMark>}
        {!!summary.commands.failed && <StatusMark spec={CHECK_RESULT.failed}>{summary.commands.failed} failed</StatusMark>}
        {!!summary.commands.notRun && <StatusMark spec={CHECK_RESULT["not-run"]}>{summary.commands.notRun} not run</StatusMark>}
      </> : <StatusMark spec={CHECK_RESULT["not-run"]}>No commands reported</StatusMark>}
    </Inline>
    <Caption>Reported by your coding tool. Nobody independent has checked it.</Caption>
    {!summary.canAccept && <StatusMark spec={CHECK_RESULT.failed} strong>Acceptance unavailable: resolve failed, unknown or not-run results and reported blockers.</StatusMark>}
    {problems.length > 0 && <Stack gap={0}><Small strong>Needs your attention</Small>{problems}</Stack>}
    {!report.risks.length && <Muted>No risks reported.</Muted>}
    {children}
    <Disclosure title={`All criteria and evidence (${report.criteria.length})`}>{report.criteria.map(criterion)}</Disclosure>
    <Disclosure title={`Commands and evidence (${report.commands.length})`}>
      {report.commands.map(command)}
      {!report.commands.length && <ResultRow spec={CHECK_RESULT["not-run"]} title="No commands reported." />}
    </Disclosure>
  </Stack>;
}
