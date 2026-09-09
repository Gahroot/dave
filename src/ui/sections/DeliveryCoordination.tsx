import { useRef, useState } from "react";
import { Alert, Button, Checkbox, Group, NativeSelect, Stack, Text, Textarea, TextInput, Title } from "@mantine/core";
import type { PortfolioProject } from "../../shared/types.ts";
import type { DeliveryState } from "../../model/delivery-schema.ts";
import type { CoordinationState, FinishContractDraft } from "../../model/delivery-coordination.ts";
import { deriveDeliveryProgress, reportFailures } from "../../model/delivery-progress.ts";
import { coordinationAssignment, planningAssignment, resultTemplate } from "../coordination-handoff.ts";
import { deliveryApi } from "../delivery-api.ts";
import { CopyText } from "../components/CopyText.tsx";

type Snapshot = { state: DeliveryState; coordination: CoordinationState };
export function DeliveryCoordination({ project, state, coordination, onSaved, today, disabled }: {
  project: PortfolioProject; state: DeliveryState; coordination: CoordinationState;
  onSaved: (value: Snapshot) => void; today: boolean; disabled: boolean;
}) {
  const [contract, setContract] = useState<FinishContractDraft>(() => coordination.contract ?? { outcome: state.goal?.goal ?? "", exclusions: [], criteria: [{ text: "", milestones: [2] }, { text: "", milestones: [2] }], prerequisites: [] });
  const [planText, setPlanText] = useState("");
  const [resultText, setResultText] = useState("");
  const [reason, setReason] = useState("");
  const [proof, setProof] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [importReviewed, setImportReviewed] = useState(false);
  const [planReviewed, setPlanReviewed] = useState(false);
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const retry = useRef<{ text: string; revision: number; key: string } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const progress = deriveDeliveryProgress(state, coordination);
  const item = progress.next;
  const plan = state.plans.find(p => p.id === state.currentPlanId);
  const locked = busy || disabled || project.override.hidden;
  const run = async (action: string, body: object, success: string) => {
    if (lock.current || locked) return false;
    lock.current = true; setBusy(true); setError("");
    try {
      const value = await deliveryApi<Snapshot>(`/api/projects/${encodeURIComponent(project.id)}/delivery/coordination/${action}`, { expectedRevision: state.revision, ...body });
      onSaved(value); setNotice(success); setConfirmed(false);
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : "Save failed. Your draft is retained; reload saved state before retrying."); return false; }
    finally { lock.current = false; setBusy(false); }
  };
  let assignment = "", reviewAssignment = "", planning = "", copyError = "";
  try {
    planning = planningAssignment(project.name, project.canonicalPath, state, coordination);
    if (item?.handoff) {
      const input = { projectName: project.name, projectPath: project.canonicalPath, state, coordination, handoff: item.handoff };
      assignment = coordinationAssignment(input); reviewAssignment = coordinationAssignment({ ...input, review: true });
    }
  } catch (e) { copyError = e instanceof Error ? e.message : "Assignment unavailable"; }
  const submit = async () => {
    try {
      const parsed: unknown = JSON.parse(resultText);
      if (retry.current?.text !== resultText) retry.current = { text: resultText, revision: state.revision, key: crypto.randomUUID() };
      const saved = retry.current;
      if (await run("report", { expectedRevision: saved.revision, idempotencyKey: saved.key, report: parsed }, "Result saved for review. No milestone was accepted automatically.")) { retry.current = null; setResultText(""); }
    } catch { setError("Paste the exact result JSON without markdown fences. Your draft is retained."); }
  };
  let resultPreview = "", planPreview = "";
  try { if (resultText.trim()) resultPreview = JSON.stringify(JSON.parse(resultText), null, 2); } catch { /* Submit supplies the actionable validation error. */ }
  try { if (planText.trim()) planPreview = JSON.stringify(JSON.parse(planText), null, 2); } catch { /* Preserve incomplete pasted JSON. */ }
  const destinationOptions = [{ value: "", label: "Not mapped yet" }, ...Array.from({ length: plan?.milestones.length ?? 3 }, (_, i) => ({ value: String(i), label: `Milestone ${i + 1}${plan ? `: ${plan.milestones[i]!.title}` : ""}` }))];
  return <Stack gap="sm" data-coordination>
    {error && <Alert color="red" title="Not saved" role="alert">{error}</Alert>}
    <Text role="status">{notice}</Text>
    <Group justify="space-between"><Title order={3} ref={heading} tabIndex={-1}>Delivery focus</Title><Button variant="default" disabled={locked || coordination.focusProjectId === project.id} onClick={() => void run("focus", {}, "Delivery focus saved. Today will use this project.")}>{coordination.focusProjectId === project.id ? "Chosen delivery focus" : "Make this my delivery focus"}</Button></Group>
    <Text>Coordinate locally. You transfer assignments and results; DAVE never runs agents or project commands.</Text>
    {progress.stale && <Alert title="Goal changed">Old evidence is retained but cannot advance this goal. Save an updated finish line and explicitly replace the old plan.</Alert>}
    {coordination.contract && <>
      <Text fw={600}>{coordination.contract.outcome}</Text>
      <Text>{progress.criteria.filter(c => c.accepted).length} of {progress.criteria.length} finish criteria user-accepted. This is not independent verification or client signoff.</Text>
      {progress.readyForReview ? <Alert title="Ready for pilot review">The saved scope is user-accepted. Arrange the authorized pilot review and record external acceptance separately. DAVE will not generate more work automatically.</Alert> : <Title order={4}>{item ? `${item.status === "needs-review" ? "Review evidence" : item.status === "handed-off" ? "Waiting for result" : "Next action"}: ${item.milestone.title}` : plan ? "Resolve prerequisites or uncovered finish criteria" : "Create the bounded delivery plan"}</Title>}
      {progress.uncovered.length > 0 && <Alert title="Uncovered finish criteria">{progress.uncovered.map(c => c.text).join("; ")}. Map these to actual milestones below.</Alert>}
      {item && <>
        <Text>{item.milestone.outcome}</Text>
        {item.status === "ready" && <Button disabled={locked} onClick={() => void run("handoff", { milestoneId: item.milestone.id }, "Handoff prepared and saved. Copy it into your coding tool; nothing has been executed.")}>Prepare this assignment</Button>}
        {item.handoff && !copyError && <>
          <Group>{item.status !== "needs-review" && <CopyText text={assignment} label="Copy implementation assignment" />}<CopyText text={reviewAssignment} label="Copy independent review assignment" /></Group>
          <details><summary>Exact assignment and result format</summary><Textarea label="Bound assignment" readOnly value={assignment} autosize minRows={4} maxRows={14} /><Textarea label="Required result JSON" readOnly value={JSON.stringify(resultTemplate(project.id, item.handoff), null, 2)} autosize minRows={4} maxRows={12} /></details>
          <Textarea label="Paste result JSON" description="No file is read or command executed from this report. Unknown evidence stays unverified." value={resultText} onChange={e => { setResultText(e.currentTarget.value); setImportReviewed(false); }} maxLength={64000} autosize minRows={4} maxRows={14} disabled={locked} />
          {resultPreview && <details open><summary>Review exact result before saving</summary><Textarea label="Parsed result preview" readOnly value={resultPreview} autosize minRows={3} maxRows={10} /><Checkbox label="I reviewed this result and its assignment identity" checked={importReviewed} onChange={e => setImportReviewed(e.currentTarget.checked)} /></details>}
          <Button disabled={locked || !resultText.trim() || (!!resultPreview && !importReviewed)} onClick={() => void submit()}>Save result for review</Button>
          {retry.current && <Button variant="default" disabled={locked} onClick={() => { retry.current = null; setNotice("Retry binding released. Your result draft remains; review the latest state before resubmitting."); }}>Release stale result retry</Button>}
        </>}
        {item.report && <>
          <details open><summary>Reported evidence, not independently verified</summary><Stack gap="xs"><Text>{item.report.report.outcome}</Text>{item.report.report.criteria.map(c => <Text key={c.id}>{item.handoff?.criteria.find(h => h.id === c.id)?.text ?? c.id}: {c.status}. {c.evidence}</Text>)}{item.report.report.commands.map((c, i) => <Text key={i}>{c.command}: {c.exitCode === null ? "not run" : `exit ${c.exitCode}`}. {c.evidence}</Text>)}<Text>Remaining risks: {item.report.report.risks.join("; ") || "None reported (not proof of absence)"}</Text></Stack></details>
          {!!reportFailures(item.report.report).length && <Alert title="Evidence cannot be accepted">{reportFailures(item.report.report).join("; ")}</Alert>}
          <Checkbox label="I reviewed this evidence and accept this milestone within the saved scope, not as client signoff" checked={confirmed} onChange={e => setConfirmed(e.currentTarget.checked)} disabled={locked} />
          <Button disabled={locked || !confirmed || !reason.trim() || reportFailures(item.report.report).length > 0} onClick={async () => { if (await run("review", { milestoneId: item.milestone.id, action: "accept", reason }, "User acceptance saved. The next eligible action is shown.")) { setReason(""); heading.current?.focus(); } }}>Accept reviewed milestone</Button>
        </>}
      </>}
      <Textarea label="Review reason or exact blocker" value={reason} onChange={e => setReason(e.currentTarget.value)} maxLength={2000} autosize disabled={locked} />
      {item && <Group><Button variant="default" disabled={locked || !reason.trim()} onClick={() => void run("review", { milestoneId: item.milestone.id, action: "return", reason }, "Returned for work. Previous assignments and downstream acceptance are now stale.")}>Return current milestone for work</Button><Button variant="default" disabled={locked || !reason.trim()} onClick={() => void run("block", { milestoneId: item.milestone.id, reason }, "Milestone blocked. Independent eligible work remains available.")}>Block current milestone</Button></Group>}
      <details><summary>Finish criteria, prerequisites and milestone history</summary><Stack gap="sm" mt="sm">
        {progress.criteria.map(c => <Text key={c.id}>{c.accepted ? "User-accepted" : "Not accepted"}: {c.text}</Text>)}
        {coordination.contract.prerequisites.map((p, i) => <Stack gap="xs" key={i}><Text fw={600}>{p.owner}: {p.text}</Text><Text>{coordination.resolutions[`p${i}`] ? `User-reported resolution: ${coordination.resolutions[`p${i}`]}` : "Unresolved"}</Text><Textarea label={`Resolution evidence for prerequisite ${i + 1}`} value={proof[`p${i}`] ?? ""} onChange={e => setProof({ ...proof, [`p${i}`]: e.currentTarget.value })} maxLength={2000} disabled={locked} /><Button variant="default" disabled={locked || !proof[`p${i}`]?.trim()} onClick={() => void run("resolve", { prerequisiteId: `p${i}`, evidence: proof[`p${i}`] }, "Prerequisite resolution saved as user-reported evidence.")}>Record prerequisite {i + 1} resolution</Button></Stack>)}
        {progress.milestones.map(m => <Stack gap="xs" key={m.milestone.id}><Text fw={600}>{m.milestone.position + 1}. {m.milestone.title}: {m.status}</Text><Text>{m.milestone.blockedReason ?? m.prerequisites.join("; ")}</Text><Text>Acceptance: {m.milestone.acceptance.join("; ")}</Text>{(m.accepted || m.milestone.status === "blocked") && <Button variant="default" disabled={locked || !reason.trim()} onClick={() => void run("review", { milestoneId: m.milestone.id, action: "return", reason }, "Reopened. This milestone and its dependants require fresh evidence.")}>Reopen {m.milestone.title}</Button>}</Stack>)}
        {coordination.decisions.map(d => <Text key={d.id}>{d.createdAt}: user {d.action}. {d.reason}</Text>)}
        <details><summary>All saved reports, including superseded evidence</summary>{coordination.reports.map(r => <Textarea key={r.id} label={`Report saved ${r.createdAt}`} readOnly value={JSON.stringify(r.report, null, 2)} autosize minRows={3} maxRows={10} />)}</details>
      </Stack></details>
    </>}
    {!today && <>
      <details open={!coordination.contract}><summary>Define or update the bounded finish line</summary><Stack gap="sm" mt="sm">
        <TextInput label="Finish-line outcome" value={contract.outcome} maxLength={4000} onChange={e => setContract({ ...contract, outcome: e.currentTarget.value })} disabled={locked} />
        <Textarea label="Out of scope (one per line)" value={contract.exclusions.join("\n")} maxLength={12000} onChange={e => setContract({ ...contract, exclusions: e.currentTarget.value.split("\n") })} disabled={locked} />
        {contract.criteria.map((c, i) => <Stack gap="xs" key={i}><TextInput label={`Finish criterion ${i + 1}`} value={c.text} maxLength={2000} disabled={locked} onChange={e => { const text = e.currentTarget.value; setContract({ ...contract, criteria: contract.criteria.map((x, n) => n === i ? { ...x, text } : x) }); }} /><NativeSelect label={`Milestone proving criterion ${i + 1}`} data={destinationOptions} value={c.milestones[0] === undefined ? "" : String(c.milestones[0])} disabled={locked} onChange={e => { const v = e.currentTarget.value; setContract({ ...contract, criteria: contract.criteria.map((x, n) => n === i ? { ...x, milestones: v === "" ? [] : [Number(v)] } : x) }); }} /></Stack>)}
        <Button variant="default" disabled={locked || contract.criteria.length >= 12} onClick={() => setContract({ ...contract, criteria: [...contract.criteria, { text: "", milestones: [] }] })}>Add finish criterion</Button>
        {contract.prerequisites.map((p, i) => <Stack key={i} gap="xs"><TextInput label={`Prerequisite ${i + 1}`} value={p.text} maxLength={2000} onChange={e => { const text = e.currentTarget.value; setContract({ ...contract, prerequisites: contract.prerequisites.map((x, n) => n === i ? { ...x, text } : x) }); }} disabled={locked} /><TextInput label={`Owner for prerequisite ${i + 1}`} value={p.owner} maxLength={200} onChange={e => { const owner = e.currentTarget.value; setContract({ ...contract, prerequisites: contract.prerequisites.map((x, n) => n === i ? { ...x, owner } : x) }); }} disabled={locked} /><NativeSelect label={`Prerequisite ${i + 1} blocks`} data={[{ value: "", label: "Final pilot review only" }, ...destinationOptions.slice(1)]} value={p.milestones[0] === undefined ? "" : String(p.milestones[0])} onChange={e => { const v = e.currentTarget.value; setContract({ ...contract, prerequisites: contract.prerequisites.map((x, n) => n === i ? { ...x, milestones: v === "" ? [] : [Number(v)] } : x) }); }} disabled={locked} /></Stack>)}
        <Button variant="default" disabled={locked || contract.prerequisites.length >= 12} onClick={() => setContract({ ...contract, prerequisites: [...contract.prerequisites, { text: "", owner: "", milestones: [] }] })}>Add human prerequisite</Button>
        {(coordination.contract || plan) && <Checkbox label="Replace the active scope and invalidate its previous handoffs and acceptance; retain history" checked={replaceConfirmed} onChange={e => setReplaceConfirmed(e.currentTarget.checked)} disabled={locked} />}
        <Button disabled={locked || !state.goal || (!!(coordination.contract || plan) && !replaceConfirmed)} onClick={async () => { if (await run("contract", { contract: { outcome: contract.outcome, criteria: contract.criteria, prerequisites: contract.prerequisites, exclusions: contract.exclusions.filter(x => x.trim()) } }, "Finish line saved. Create or review the milestone plan next.")) setReplaceConfirmed(false); }}>Save finish line</Button>
      </Stack></details>
      {coordination.contract && <details open={!plan}><summary>Plan without a model connection</summary><Stack gap="sm" mt="sm"><Text>Copy this planning brief into your coding tool. Paste its complete plan JSON below. Import saves a user-authored proposal locally, not verified findings.</Text>{!copyError && <CopyText text={planning} label="Copy planning assignment" />}<Textarea label="Paste milestone plan JSON" value={planText} onChange={e => { setPlanText(e.currentTarget.value); setPlanReviewed(false); }} maxLength={64000} autosize minRows={5} maxRows={16} disabled={locked} />{planPreview && <details open><summary>Review exact plan before saving</summary><Textarea label="Parsed plan preview" readOnly value={planPreview} autosize minRows={3} maxRows={10} /><Checkbox label="I reviewed this plan and its dependency order" checked={planReviewed} onChange={e => setPlanReviewed(e.currentTarget.checked)} /></details>}{plan && <Checkbox label="Replace this plan; retain old reports but require fresh evidence for the new plan" checked={replaceConfirmed} onChange={e => setReplaceConfirmed(e.currentTarget.checked)} disabled={locked} />}<Button disabled={locked || !planText.trim() || !planReviewed || (!!plan && !replaceConfirmed)} onClick={async () => { if (await run("plan", { plan: planText }, "Plan imported locally. No model or project command was called.")) { setPlanText(""); setReplaceConfirmed(false); } }}>Import reviewed milestone plan</Button></Stack></details>}
    </>}
    {copyError && <Alert color="red" title="Copy unavailable">{copyError}</Alert>}
  </Stack>;
}
