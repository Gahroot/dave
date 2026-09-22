import { useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Group, NativeSelect, Stack, Text, Textarea, TextInput, Title } from "@mantine/core";
import type { PortfolioProject } from "../../shared/types.ts";
import type { DeliveryState } from "../../model/delivery-schema.ts";
import type { CoordinationState, FinishContractDraft } from "../../model/delivery-coordination.ts";
import { deriveDeliveryProgress, reportFailures } from "../../model/delivery-progress.ts";
import { nextDeliveryStep } from "../../model/delivery-next-step.ts";
import { withStaleHandoff } from "../../model/delivery-queue.ts";
import { coordinationAssignment, planningAssignment, resultTemplate } from "../coordination-handoff.ts";
import { deliveryApi } from "../delivery-api.ts";
import { CopyText } from "../components/CopyText.tsx";
import { EngagementButton } from "./DeliveryQueue.tsx";
import { WorkMethod, MilestoneSequence, StagePanel } from "./delivery/StagePanels.tsx";
import { useDraftGuard } from "../hooks/useDraftGuard.ts";
import { parseRoute } from "../navigation.ts";
import { NextActionRow } from "../components/WorkspacePrimitives.tsx";

type Snapshot = { state: DeliveryState; coordination: CoordinationState };
export function DeliveryCoordination({ project, state, coordination, onSaved, today, disabled }: {
  project: PortfolioProject; state: DeliveryState; coordination: CoordinationState;
  onSaved: (value: Snapshot) => void; today: boolean; disabled: boolean;
}) {
  const [contract, setContract] = useState<FinishContractDraft>(() => coordination.contract ?? { outcome: state.goal?.goal ?? "", exclusions: [], criteria: [{ text: "", milestones: [2] }, { text: "", milestones: [2] }], prerequisites: [] });
  const [contractSaved, setContractSaved] = useState(() => JSON.stringify(contract));
  const [method, setMethod] = useState<"connected" | "manual">("connected");
  const [scopeOpen, setScopeOpen] = useState(false), [planOpen, setPlanOpen] = useState(false);
  const [planText, setPlanText] = useState("");
  const [resultText, setResultText] = useState("");
  const [reason, setReason] = useState("");
  const [proof, setProof] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [importReviewed, setImportReviewed] = useState(false);
  const [planReviewed, setPlanReviewed] = useState(false);
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pack, setPack] = useState("");
  const lock = useRef(false);
  const retry = useRef<{ text: string; revision: number; key: string } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const draftDestination = useRef(parseRoute(location.hash).destination);
  useDraftGuard(JSON.stringify(contract) !== contractSaved || !!planText || !!resultText || !!reason || Object.values(proof).some(Boolean), hash => { const destination = parseRoute(hash); const route = destination.destination === "connections" && destination.returnTo ? parseRoute(destination.returnTo) : destination; return route.destination === draftDestination.current && (route.destination === "projects" && route.id === project.id || route.destination === "queue" && route.delivery === project.id); });
  const progress = deriveDeliveryProgress(state, coordination);
  const step = withStaleHandoff(nextDeliveryStep(state, coordination), coordination, new Date());
  const item = progress.next;
  const plan = state.plans.find(p => p.id === state.currentPlanId);
  const locked = busy || disabled || project.override.hidden;
  useEffect(() => { setScopeOpen(step.kind === "scope"); setPlanOpen(step.kind === "plan"); }, [step.kind]);
  const run = async (action: string, body: object, success: string) => {
    if (lock.current || locked) return false;
    lock.current = true; setBusy(true); setError("");
    try {
      const value = await deliveryApi<Snapshot>(`/api/projects/${encodeURIComponent(project.id)}/delivery/coordination/${action}`, { expectedRevision: state.revision, ...body });
      onSaved(value); setNotice(success); setConfirmed(false);
      if (action === "contract") { setContractSaved(JSON.stringify(contract)); setScopeOpen(false); }
      if (action === "plan") setPlanOpen(false);
      if (["review", "block", "resend"].includes(action)) setReason("");
      if (action === "resolve") setProof({});
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
    <NextActionRow title={<Title order={3} ref={heading} tabIndex={-1}>{step.headline}</Title>} action={<EngagementButton projectId={project.id} revision={state.revision} engagement={coordination.engagement} disabled={locked} onSaved={value => { onSaved(value as Snapshot); setNotice(coordination.engagement === "active" ? "Paused. It stays where it is until you pick it back up." : "On the go. It now shows in your delivery list."); }} />}><Text>{step.why}</Text></NextActionRow>
    <MilestoneSequence items={progress.milestones.map(m => ({ id: m.milestone.id, title: m.milestone.title, status: m.status }))} />
    {step.kind === "stalled" && item && <Alert color="orange" title="This has gone quiet">
      <Stack gap="sm">
        <Text size="sm">Nothing came back. Send it again, or take it back — leaving it sitting there is not one of the options.</Text>
        <Textarea label="What happened, as far as you know" value={reason} onChange={e => setReason(e.currentTarget.value)} maxLength={2000} autosize disabled={locked} />
        <Group>
          <Button variant="default" disabled={locked || !reason.trim()} onClick={() => void run("resend", { milestoneId: item.milestone.id, reason }, "Sent again with a fresh prompt. The clock starts over.")}>Send it again</Button>
          <Button variant="default" disabled={locked || !reason.trim()} onClick={() => void run("block", { milestoneId: item.milestone.id, reason }, "Taken back and parked. Anything else that can move is shown above.")}>Take it back</Button>
        </Group>
      </Stack>
    </Alert>}
    {step.kind === "decide" && item && <Alert color="red" title="Three tries is enough">
      <Stack gap="sm">
        <Text size="sm">Pick one of these. Sending it off again is not on the list, because it has not worked three times.</Text>
        <Textarea label="Why you're deciding this" value={reason} onChange={e => setReason(e.currentTarget.value)} maxLength={2000} autosize disabled={locked} />
        <Group>
          <Button variant="default" disabled={locked || !reason.trim()} onClick={() => { setContract({ ...contract, criteria: contract.criteria.filter(c => !c.milestones.includes(item.milestone.position)) }); setScopeOpen(true); setNotice("Removed from your draft below. Save it to drop this from what you promised."); }}>Cut it from what I promised</Button>
          <Button variant="default" disabled={locked || !reason.trim()} onClick={() => { setPlanOpen(true); setNotice("Break it up below: paste a new set of pieces with this one split smaller."); }}>Split it into smaller pieces</Button>
          <Button variant="default" disabled={locked || !reason.trim()} onClick={() => void run("block", { milestoneId: item.milestone.id, reason }, "Parked with the reason recorded. Anything else that can move is shown above.")}>Park it and say what I'm waiting on</Button>
        </Group>
      </Stack>
    </Alert>}
    {coordination.contract && <>
      {step.kind === "send" && item && <><Text size="sm">Send this to your coding tool, then paste back what it says.</Text><Button disabled={locked} onClick={() => void run("handoff", { milestoneId: item.milestone.id }, "Ready. Copy the prompt and send it off.")}>Get the prompt</Button></>}
      {item?.handoff && !copyError && step.kind !== "review" && <WorkMethod method={method} onChange={setMethod} connected={<Stack gap="sm">
        <Button component="a" href={`#agents?project=${encodeURIComponent(project.id)}&handoff=${encodeURIComponent(item.handoff.id)}`}>Run this assignment in DAVE</Button>
        <Text size="sm">Start explicitly in Agent desk. Returned evidence still requires milestone review here.</Text>
        </Stack>} manual={<StagePanel title="Manual handoff">
        <Textarea label="Prompt to send" readOnly value={assignment} autosize minRows={6} maxRows={16} />
        <Group><CopyText text={assignment} label="Copy prompt" /><CopyText text={reviewAssignment} label="Copy a second-opinion prompt" /></Group>
        <Textarea label="Paste result JSON" description="Nothing here is run. Ask your coding tool for the JSON block it was told to return." value={resultText} onChange={e => { setResultText(e.currentTarget.value); setImportReviewed(false); }} maxLength={64000} autosize minRows={4} maxRows={14} disabled={locked} />
        {resultPreview && <pre className="agent-output" role="region" aria-label="Parsed result for review" tabIndex={0}>{resultPreview}</pre>}
        {resultPreview && <Checkbox label="I read this before saving it" checked={importReviewed} onChange={e => setImportReviewed(e.currentTarget.checked)} />}
        <Button disabled={locked || !resultText.trim() || (!!resultPreview && !importReviewed)} onClick={() => void submit()}>Save it</Button>
        <details><summary>Exact format your coding tool must reply in</summary><Textarea label="Required reply" readOnly value={JSON.stringify(resultTemplate(project.id, item.handoff), null, 2)} autosize minRows={4} maxRows={12} /></details>
        {retry.current && <Button variant="default" disabled={locked} onClick={() => { retry.current = null; setNotice("Cleared. Check the latest saved state before saving again."); }}>Start this save over</Button>}
      </StagePanel>} />}
      {step.kind === "review" && item?.report && <StagePanel title="Review milestone evidence">
        <Stack gap="xs"><Text>{item.report.report.outcome}</Text>{item.report.report.criteria.map(c => <Text key={c.id}>{item.handoff?.criteria.find(h => h.id === c.id)?.text ?? c.id}: {c.status}. {c.evidence}</Text>)}{item.report.report.commands.map((c, i) => <Text key={i}>{c.command}: {c.exitCode === null ? "not run" : `exit ${c.exitCode}`}. {c.evidence}</Text>)}<Text>Watch out for: {item.report.report.risks.join("; ") || "nothing flagged, which is not the same as nothing wrong"}</Text></Stack>
        {!!reportFailures(item.report.report).length && <Alert title="Not finished yet">{reportFailures(item.report.report).join("; ")}</Alert>}
        <Textarea label="Acceptance evidence or reason" description="Acceptance records your decision about this report. It is not independent verification or client signoff and does not merge or deploy anything." value={reason} onChange={e => setReason(e.currentTarget.value)} maxLength={2000} autosize disabled={locked} />
        <Checkbox label="I read this and I'm happy with it" checked={confirmed} onChange={e => setConfirmed(e.currentTarget.checked)} disabled={locked} />
        <Button disabled={locked || !confirmed || !reason.trim() || reportFailures(item.report.report).length > 0} onClick={async () => { if (await run("review", { milestoneId: item.milestone.id, action: "accept", reason }, "Saved. Your next thing is above.")) { setReason(""); heading.current?.focus(); } }}>Looks good, move on</Button>
      </StagePanel>}
      {progress.readyForReview && <details open><summary>Write up what you delivered</summary><Stack gap="sm" mt="sm">
        <Text size="sm">Built from what you already accepted. Nothing is re-run and nothing is sent anywhere — read it before you pass it on.</Text>
        {!pack && <Button disabled={locked} onClick={() => {
          setError("");
          void fetch(`/api/projects/${encodeURIComponent(project.id)}/delivery/pack`)
            .then(async res => res.ok ? (await res.json() as { markdown: string }).markdown : Promise.reject(new Error(((await res.json().catch(() => ({}))) as { message?: string }).message ?? "Could not put the write-up together.")))
            .then(setPack)
            .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not put the write-up together."));
        }}>Put it together</Button>}
        {pack && <><Textarea label="What you delivered" readOnly value={pack} autosize minRows={10} maxRows={24} /><CopyText text={pack} label="Copy the write-up" /></>}
      </Stack></details>}
      {item && step.kind !== "decide" && <details><summary>Send it back, or park it</summary><Stack gap="sm" mt="sm"><Textarea label="What's wrong, or what you're waiting on" value={reason} onChange={e => setReason(e.currentTarget.value)} maxLength={2000} autosize disabled={locked} /><Group><Button variant="default" disabled={locked || !reason.trim()} onClick={() => void run("review", { milestoneId: item.milestone.id, action: "return", reason }, "Sent back. Anything built on top of it needs redoing too.")}>Send back for more work</Button><Button variant="default" disabled={locked || !reason.trim()} onClick={() => void run("block", { milestoneId: item.milestone.id, reason }, "Parked. Anything else that can move is shown above.")}>Park it, I'm blocked</Button></Group></Stack></details>}
      <details><summary>The whole picture: {progress.criteria.filter(c => c.accepted).length} of {progress.criteria.length} promises done</summary><Stack gap="sm" mt="sm">
        <Text fw={600}>{coordination.contract.outcome}</Text>
        <Text size="sm">Done here means you accepted it. Nobody independent has checked it and the client hasn't signed anything off.</Text>
        {progress.criteria.map(c => <Text key={c.id}>{c.accepted ? "Done" : "Not yet"}: {c.text}</Text>)}
        <Textarea label="Reason to reopen completed work" value={reason} onChange={event => setReason(event.currentTarget.value)} maxLength={2000} disabled={locked} />
        {progress.milestones.map(m => <Stack gap="xs" key={m.milestone.id}><Text fw={600}>{m.milestone.position + 1}. {m.milestone.title}: {m.status}</Text><Text>{m.milestone.blockedReason ?? m.prerequisites.join("; ")}</Text>{(m.accepted || m.milestone.status === "blocked") && <Button variant="default" disabled={locked || !reason.trim()} onClick={() => void run("review", { milestoneId: m.milestone.id, action: "return", reason }, "Reopened. Anything built on top of it needs redoing too.")}>Redo {m.milestone.title}</Button>}</Stack>)}
        {coordination.decisions.map(d => <Text key={d.id}>{d.createdAt}: you {d.action === "accept" ? "accepted" : "sent back"}. {d.reason}</Text>)}
        <details><summary>Everything your coding tool has sent back</summary>{coordination.reports.map(r => <Textarea key={r.id} label={`Sent back ${r.createdAt}`} readOnly value={JSON.stringify(r.report, null, 2)} autosize minRows={3} maxRows={10} />)}</details>
      </Stack></details>
      {coordination.contract.prerequisites.length > 0 && <details open={step.kind === "unblock"}><summary>Waiting on people ({progress.unresolved.length} outstanding)</summary><Stack gap="sm" mt="sm">
        {coordination.contract.prerequisites.map((p, i) => <Stack gap="xs" key={i}><Text fw={600}>{p.owner}: {p.text}</Text>{coordination.resolutions[`p${i}`] ? <Text>Sorted: {coordination.resolutions[`p${i}`]}</Text> : <><Textarea label={`How it got sorted`} value={proof[`p${i}`] ?? ""} onChange={e => setProof({ ...proof, [`p${i}`]: e.currentTarget.value })} maxLength={2000} disabled={locked} /><Button variant="default" disabled={locked || !proof[`p${i}`]?.trim()} onClick={() => void run("resolve", { prerequisiteId: `p${i}`, evidence: proof[`p${i}`] }, "Saved. Work that was waiting on this can move.")}>Mark this sorted</Button></>}</Stack>)}
      </Stack></details>}
    </>}
    {(!today || step.kind === "scope" || step.kind === "plan" || scopeOpen || planOpen) && <>
      <details open={scopeOpen} onToggle={event => setScopeOpen(event.currentTarget.open)}><summary>What counts as finished</summary><Stack gap="sm" mt="sm">
        <Text size="sm">Two to twelve things you could watch happen. Keep them plain: what someone can do, not how it's built.</Text>
        <TextInput label="What does done look like, in one line" value={contract.outcome} maxLength={4000} onChange={e => setContract({ ...contract, outcome: e.currentTarget.value })} disabled={locked} />
        <Textarea label="Not doing (one per line)" value={contract.exclusions.join("\n")} maxLength={12000} onChange={e => setContract({ ...contract, exclusions: e.currentTarget.value.split("\n") })} disabled={locked} />
        {contract.criteria.map((c, i) => <Stack gap="xs" key={i}><TextInput label={`Thing ${i + 1} I could watch happen`} value={c.text} maxLength={2000} disabled={locked} onChange={e => { const text = e.currentTarget.value; setContract({ ...contract, criteria: contract.criteria.map((x, n) => n === i ? { ...x, text } : x) }); }} /><NativeSelect label={`Which piece of work proves thing ${i + 1}`} data={destinationOptions} value={c.milestones[0] === undefined ? "" : String(c.milestones[0])} disabled={locked} onChange={e => { const v = e.currentTarget.value; setContract({ ...contract, criteria: contract.criteria.map((x, n) => n === i ? { ...x, milestones: v === "" ? [] : [Number(v)] } : x) }); }} /></Stack>)}
        <Button variant="default" disabled={locked || contract.criteria.length >= 12} onClick={() => setContract({ ...contract, criteria: [...contract.criteria, { text: "", milestones: [] }] })}>Add another</Button>
        {contract.prerequisites.map((p, i) => <Stack key={i} gap="xs"><TextInput label={`Thing ${i + 1} you need from a person`} value={p.text} maxLength={2000} onChange={e => { const text = e.currentTarget.value; setContract({ ...contract, prerequisites: contract.prerequisites.map((x, n) => n === i ? { ...x, text } : x) }); }} disabled={locked} /><TextInput label={`Who you need it from`} value={p.owner} maxLength={200} onChange={e => { const owner = e.currentTarget.value; setContract({ ...contract, prerequisites: contract.prerequisites.map((x, n) => n === i ? { ...x, owner } : x) }); }} disabled={locked} /><NativeSelect label={`What it holds up`} data={[{ value: "", label: "Only the final review" }, ...destinationOptions.slice(1)]} value={p.milestones[0] === undefined ? "" : String(p.milestones[0])} onChange={e => { const v = e.currentTarget.value; setContract({ ...contract, prerequisites: contract.prerequisites.map((x, n) => n === i ? { ...x, milestones: v === "" ? [] : [Number(v)] } : x) }); }} disabled={locked} /></Stack>)}
        <Button variant="default" disabled={locked || contract.prerequisites.length >= 12} onClick={() => setContract({ ...contract, prerequisites: [...contract.prerequisites, { text: "", owner: "", milestones: [] }] })}>Add something you need from a person</Button>
        {(coordination.contract || plan) && <Checkbox label="Replace what I had before. Work already accepted will need checking again." checked={replaceConfirmed} onChange={e => setReplaceConfirmed(e.currentTarget.checked)} disabled={locked} />}
        <Button disabled={locked || !state.goal || (!!(coordination.contract || plan) && !replaceConfirmed)} onClick={async () => { if (await run("contract", { contract: { outcome: contract.outcome, criteria: contract.criteria, prerequisites: contract.prerequisites, exclusions: contract.exclusions.filter(x => x.trim()) } }, "Saved. Next, break the work into pieces.")) setReplaceConfirmed(false); }}>Save this</Button>
      </Stack></details>
      {coordination.contract && <details open={planOpen} onToggle={event => setPlanOpen(event.currentTarget.open)}><summary>Break the work into pieces</summary><Stack gap="sm" mt="sm"><Text>Send this to your coding tool. It reads the code and proposes the pieces; paste its answer back. Nothing is decided until you save it.</Text>{!copyError && <><Textarea label="Prompt to send" readOnly value={planning} autosize minRows={6} maxRows={16} /><CopyText text={planning} label="Copy prompt" /></>}<Textarea label="Paste milestone plan JSON" value={planText} onChange={e => { setPlanText(e.currentTarget.value); setPlanReviewed(false); }} maxLength={64000} autosize minRows={5} maxRows={16} disabled={locked} />{planPreview && <Checkbox label="I read these pieces and the order they go in" checked={planReviewed} onChange={e => setPlanReviewed(e.currentTarget.checked)} />}{plan && <Checkbox label="Replace the old pieces. Old results stay, but the new work needs fresh proof." checked={replaceConfirmed} onChange={e => setReplaceConfirmed(e.currentTarget.checked)} disabled={locked} />}<Button disabled={locked || !planText.trim() || !planReviewed || (!!plan && !replaceConfirmed)} onClick={async () => { if (await run("plan", { plan: planText }, "Saved. Your first piece of work is at the top.")) { setPlanText(""); setReplaceConfirmed(false); } }}>Save these pieces</Button></Stack></details>}
    </>}
    {copyError && <Alert color="red" title="Copy unavailable">{copyError}</Alert>}
  </Stack>;
}
