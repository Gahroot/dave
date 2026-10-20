/**
 * Port of src/ui/sections/DeliveryCoordination.tsx: finish line, pieces of work,
 * handoffs (connected vs manual), evidence review and explicit acceptance.
 * Returns sibling Panels (never nested) for the parent's ScrollView.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "expo-router";
import { Bot, Check, CircleCheck, CircleDashed, ClockAlert, Gavel, Hand, Info, Pause, Plus, RotateCcw, Scissors, Send, Split, Undo2, UserCheck } from "lucide-react-native";
import type { PortfolioProject } from "../../../../src/shared/types.ts";
import type { DeliveryState } from "../../../../src/model/delivery-schema.ts";
import type { CoordinationState, FinishContractDraft } from "../../../../src/model/delivery-coordination.ts";
import { deriveDeliveryProgress } from "../../../../src/model/delivery-progress.ts";
import { nextDeliveryStep } from "../../../../src/model/delivery-next-step.ts";
import { withStaleHandoff } from "../../../../src/model/delivery-queue.ts";
import { coordinationAssignment, planningAssignment, resultTemplate } from "../../../../src/ui/coordination-handoff.ts";
import { summarizeReview } from "../../../../src/ui/delivery-review-model.ts";
import { MILESTONE_STATUS, NEXT_STEP } from "../../../../src/ui/status.ts";
import { relative } from "../../../../src/ui/format.ts";
import { Banner, Body, Button, Caption, Code, CopyButton, Disclosure, Inline, Muted, Panel, SelectField, Small, Stack, TextField, Toggle, confirm, tick } from "../../ui/primitives";
import { StatusMark, type StatusSpec } from "../../ui/status";
import { useDeliveryApi } from "./api";
import { EngagementButton } from "./EngagementButton";
import { ReviewEvidence } from "./ReviewEvidence";
import { MilestoneSequence, ResultRow, WorkMethod, useDraftGuard, type Method } from "./StagePanels";
import { destinationFrom, destinationOptions, destinationValue, prettyJson, randomKey, truncate, UNMAPPED } from "./model";

export type Snapshot = { state: DeliveryState; coordination: CoordinationState };
const NOT_YET: StatusSpec = { tone: "gray", icon: CircleDashed, label: "Not yet" };
const SENT_BACK: StatusSpec = { tone: "amber", icon: Undo2, label: "Sent back" };
const SORTED: StatusSpec = { tone: "green", icon: CircleCheck, label: "Sorted" };
const WAITING: StatusSpec = { tone: "amber", icon: Hand, label: "Waiting" };
const ACCEPT_NOTE = "Accepting records your decision. It is not independent verification or client signoff and does not merge or deploy anything.";

export function DeliveryCoordination({ project, state, coordination, onSaved, today, disabled }: {
  project: PortfolioProject; state: DeliveryState; coordination: CoordinationState;
  onSaved: (value: Snapshot) => void; today: boolean; disabled: boolean;
}) {
  const call = useDeliveryApi();
  const router = useRouter();
  const [contract, setContract] = useState<FinishContractDraft>(() => coordination.contract ?? { outcome: state.goal?.goal ?? "", exclusions: [], criteria: [{ text: "", milestones: [2] }, { text: "", milestones: [2] }], prerequisites: [] });
  const [contractSaved, setContractSaved] = useState(() => JSON.stringify(contract));
  const [method, setMethod] = useState<Method>("connected");
  const [scopeOpen, setScopeOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
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
  useDraftGuard(JSON.stringify(contract) !== contractSaved || !!planText || !!resultText || !!reason || Object.values(proof).some(Boolean));

  const progress = deriveDeliveryProgress(state, coordination);
  const step = withStaleHandoff(nextDeliveryStep(state, coordination), coordination, new Date());
  const item = progress.next;
  const plan = state.plans.find((p) => p.id === state.currentPlanId);
  const locked = busy || disabled || project.override.hidden;
  useEffect(() => { setScopeOpen(step.kind === "scope"); setPlanOpen(step.kind === "plan"); }, [step.kind]);

  const run = async (action: string, body: object, success: string): Promise<boolean> => {
    if (lock.current || locked) return false;
    lock.current = true; setBusy(true); setError("");
    try {
      const value = await call<Snapshot>(`/api/projects/${encodeURIComponent(project.id)}/delivery/coordination/${action}`, { expectedRevision: state.revision, ...body });
      onSaved(value); setNotice(success); setConfirmed(false); tick();
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
    let parsed: unknown;
    try { parsed = JSON.parse(resultText); } catch { setError("Paste the exact result JSON without markdown fences. Your draft is retained."); return; }
    if (retry.current?.text !== resultText) retry.current = { text: resultText, revision: state.revision, key: randomKey() };
    const saved = retry.current;
    if (await run("report", { expectedRevision: saved.revision, idempotencyKey: saved.key, report: parsed }, "Result saved for review. No milestone was accepted automatically.")) { retry.current = null; setResultText(""); }
  };
  const loadPack = async () => {
    setError("");
    try { setPack((await call<{ markdown: string }>(`/api/projects/${encodeURIComponent(project.id)}/delivery/pack`)).markdown); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not put the write-up together."); }
  };
  const resultPreview = prettyJson(resultText);
  const planPreview = prettyJson(planText);
  const destinations = destinationOptions(plan);
  const criteriaDestinations = [{ value: UNMAPPED, label: "Not mapped yet" }, ...destinations];
  const prerequisiteDestinations = [{ value: UNMAPPED, label: "Only the final review" }, ...destinations];
  const acceptedCount = progress.criteria.filter((c) => c.accepted).length;
  const allAccepted = progress.criteria.length > 0 && progress.criteria.every((c) => c.accepted);
  const canAccept = item?.report ? summarizeReview(item.report.report).canAccept : false;
  const savedOutcome = coordination.contract ? truncate(coordination.contract.outcome, 240) : null;
  const feedback = <>
    {error ? <Banner tone="red" title="Not saved" message={error} /> : null}
    {notice ? <Banner tone="blue" title={notice} /> : null}
  </>;
  const reasonField = (label: string, help?: string) => <TextField label={label} help={help} value={reason} onChangeText={setReason} maxLength={2000} multiline editable={!locked} />;
  const returnIt = () => void run("review", { milestoneId: item?.milestone.id, action: "return", reason }, "Sent back. Anything built on top of it needs redoing too.");
  const parkIt = (success = "Parked. Anything else that can move is shown above.") => void run("block", { milestoneId: item?.milestone.id, reason }, success);
  const showForms = !today || step.kind === "scope" || step.kind === "plan" || scopeOpen || planOpen;

  return <>
    <Panel title={step.headline} spec={NEXT_STEP[step.kind]} note={step.kind !== "review" ? step.why : undefined}>
      {feedback}
      {savedOutcome && <Stack gap={4}>
        <Muted selectable>Saved outcome: {savedOutcome.short}</Muted>
        {savedOutcome.truncated && <Disclosure title="Full saved outcome"><Body selectable>{coordination.contract?.outcome ?? ""}</Body></Disclosure>}
      </Stack>}
      {coordination.contract && <Stack gap={8}>
        <StatusMark spec={{ tone: allAccepted ? "green" : "gray", icon: allAccepted ? CircleCheck : CircleDashed, label: "" }}>{acceptedCount} of {progress.criteria.length} promises accepted by you</StatusMark>
        {progress.unresolved.length > 0 && <StatusMark spec={WAITING}>{progress.unresolved.length} waiting on people</StatusMark>}
        <MilestoneSequence items={progress.milestones.map((m) => ({ id: m.milestone.id, title: m.milestone.title, status: m.status }))} current={item?.milestone.id} />
      </Stack>}

      {step.kind === "stalled" && item && <Banner tone="amber" title="This has gone quiet" message={<Stack gap={8}>
        <Small>Nothing came back. Send it again, or take it back — leaving it sitting there is not one of the options.</Small>
        {reasonField("What happened, as far as you know")}
        <Inline>
          <Button title="Send it again" icon={Send} variant="primary" disabled={locked || !reason.trim()} onPress={() => void run("resend", { milestoneId: item.milestone.id, reason }, "Sent again with a fresh prompt. The clock starts over.")} />
          <Button title="Take it back" icon={Undo2} disabled={locked || !reason.trim()} onPress={() => parkIt("Taken back and parked. Anything else that can move is shown above.")} />
        </Inline>
      </Stack>} />}

      {step.kind === "decide" && item && <Banner tone="red" title="Three tries is enough" message={<Stack gap={8}>
        <Small>Pick one of these. Sending it off again is not on the list, because it has not worked three times.</Small>
        {reasonField("Why you're deciding this")}
        <Stack gap={8}>
          <Button title="Cut it from what I promised" icon={Scissors} disabled={locked || !reason.trim()} onPress={() => { setContract({ ...contract, criteria: contract.criteria.filter((c) => !c.milestones.includes(item.milestone.position)) }); setScopeOpen(true); setNotice("Removed from your draft below. Save it to drop this from what you promised."); }} />
          <Button title="Split it into smaller pieces" icon={Split} disabled={locked || !reason.trim()} onPress={() => { setPlanOpen(true); setNotice("Break it up below: paste a new set of pieces with this one split smaller."); }} />
          <Button title="Park it and say what I'm waiting on" icon={Pause} disabled={locked || !reason.trim()} onPress={() => parkIt("Parked with the reason recorded. Anything else that can move is shown above.")} />
        </Stack>
      </Stack>} />}

      {coordination.contract && step.kind === "send" && item && <>
        <Muted>Send this to your coding tool, then paste back what it says.</Muted>
        <Button title="Get the prompt" icon={Send} variant="primary" loading={busy} disabled={locked} onPress={() => void run("handoff", { milestoneId: item.milestone.id }, "Ready. Copy the prompt and send it off.")} />
      </>}

      {coordination.contract && item?.handoff && !copyError && step.kind !== "review" && <WorkMethod method={method} onChange={setMethod}
        connected={<Stack gap={8}>
          <Button title="Run this assignment in DAVE" icon={Bot} variant="primary"
            onPress={() => { const handoff = item.handoff; if (handoff) router.push(`/agents/new?project=${encodeURIComponent(project.id)}&handoff=${encodeURIComponent(handoff.id)}`); }} />
          <Muted>Start explicitly in Agent desk. Returned evidence still requires milestone review here.</Muted>
        </Stack>}
        manual={<Stack gap={10}>
          <Small strong>Prompt to send</Small>
          <Code>{assignment}</Code>
          <Inline><CopyButton text={assignment} label="Copy prompt" /><CopyButton text={reviewAssignment} label="Copy a second-opinion prompt" /></Inline>
          <TextField label="Paste result JSON" help="Nothing here is run. Ask your coding tool for the JSON block it was told to return." value={resultText}
            onChangeText={(value) => { setResultText(value); setImportReviewed(false); }} maxLength={64000} multiline editable={!locked} autoCapitalize="none" autoCorrect={false} />
          {resultPreview ? <><Small strong>Parsed result for review</Small><Code>{resultPreview}</Code>
            <Toggle label="I read this before saving it" value={importReviewed} onValueChange={setImportReviewed} /></> : null}
          <Button title="Save it" icon={Check} variant="primary" loading={busy} disabled={locked || !resultText.trim() || (!!resultPreview && !importReviewed)} onPress={() => void submit()} />
          <Disclosure title="Exact format your coding tool must reply in">
            <Code>{JSON.stringify(resultTemplate(project.id, item.handoff), null, 2)}</Code>
            <CopyButton text={JSON.stringify(resultTemplate(project.id, item.handoff), null, 2)} label="Copy required reply" />
          </Disclosure>
          {retry.current && <Button title="Start this save over" disabled={locked} onPress={() => { retry.current = null; setNotice("Cleared. Check the latest saved state before saving again."); }} />}
        </Stack>} />}

      {coordination.contract && progress.readyForReview && <Disclosure title="Write up what you delivered" defaultOpen>
        <Muted>Built from what you already accepted. Nothing is re-run and nothing is sent anywhere — read it before you pass it on.</Muted>
        {!pack && <Button title="Put it together" variant="primary" disabled={locked} onPress={() => void loadPack()} />}
        {pack ? <><Small strong>What you delivered</Small><Code>{pack}</Code><CopyButton text={pack} label="Copy the write-up" /></> : null}
      </Disclosure>}

      {coordination.contract && item && step.kind !== "decide" && step.kind !== "review" && <Disclosure title="Send it back, or park it">
        {reasonField("What's wrong, or what you're waiting on")}
        <Inline>
          <Button title="Send back for more work" icon={Undo2} disabled={locked || !reason.trim()} onPress={returnIt} />
          <Button title="Park it, I'm blocked" icon={Pause} variant="subtle" disabled={locked || !reason.trim()} onPress={() => parkIt()} />
        </Inline>
      </Disclosure>}

      <EngagementButton projectId={project.id} revision={state.revision} engagement={coordination.engagement} disabled={locked}
        onSaved={(value) => { onSaved(value as Snapshot); setNotice(coordination.engagement === "active" ? "Paused. It stays where it is until you pick it back up." : "On the go. It now shows in your delivery list."); }} />
      {copyError ? <Banner tone="red" title="Copy unavailable" message={copyError} /> : null}
    </Panel>

    {coordination.contract && step.kind === "review" && item?.report && <Panel title="Review milestone evidence" spec={NEXT_STEP.review}>
      <ReviewEvidence report={item.report.report} handoff={item.handoff} prerequisites={progress.unresolved.map((p) => `${p.owner}: ${p.text}`)}>
        {reasonField("Acceptance evidence or reason", "Saved with your decision.")}
        <Toggle label="I read this and I'm happy with it" value={confirmed} onValueChange={setConfirmed} disabled={locked} />
        <Banner tone="blue" title="What accepting means" message={<Inline wrap={false}><Info size={14} /><Small>{ACCEPT_NOTE}</Small></Inline>} />
        {feedback}
        <Button title="Looks good, move on" icon={UserCheck} variant={canAccept ? "primary" : "secondary"} loading={busy}
          disabled={locked || !confirmed || !reason.trim() || !canAccept}
          onPress={() => void run("review", { milestoneId: item.milestone.id, action: "accept", reason }, "Saved. Your next thing is above.")} />
        <Button title="Send back for more work" icon={Undo2} variant={canAccept ? "secondary" : "primary"} disabled={locked || !reason.trim()} onPress={returnIt} />
        <Button title="Park it, I'm blocked" icon={Pause} variant="subtle" disabled={locked || !reason.trim()} onPress={() => parkIt()} />
      </ReviewEvidence>
    </Panel>}

    {coordination.contract && <Panel title="The whole picture" note={`${acceptedCount} of ${progress.criteria.length} promises done`}>
      <Disclosure title="Promises, pieces of work and history">
        <Body strong selectable>{coordination.contract.outcome}</Body>
        <Caption>Done here means you accepted it. Nobody independent has checked it and the client hasn't signed anything off.</Caption>
        <Small strong>Promises</Small>
        {progress.criteria.map((c) => <ResultRow key={c.id} spec={c.accepted ? MILESTONE_STATUS.accepted : NOT_YET} title={c.text} detail={c.accepted ? "Done: accepted by you" : "Not yet"} />)}
        <Small strong>Pieces of work</Small>
        {progress.milestones.map((m) => {
          const spec = MILESTONE_STATUS[m.status];
          const extra = m.milestone.blockedReason ?? m.prerequisites.join("; ");
          return <ResultRow key={m.milestone.id} spec={spec} title={`${m.milestone.position + 1}. ${m.milestone.title}`} detail={`${spec.label}${extra ? ` · ${extra}` : ""}`}>
            {(m.accepted || m.milestone.status === "blocked") && <Button title={`Redo ${m.milestone.title}`} icon={RotateCcw} variant="subtle" compact disabled={locked || !reason.trim()}
              onPress={() => void confirm({ title: `Redo ${m.milestone.title}?`, message: "Anything built on top of it needs redoing too.", confirmLabel: "Redo" })
                .then((ok) => { if (ok) void run("review", { milestoneId: m.milestone.id, action: "return", reason }, "Reopened. Anything built on top of it needs redoing too."); })} />}
          </ResultRow>;
        })}
        {reasonField("Reason to reopen completed work", "Needed before any Redo button above will work.")}
        {feedback}
        {coordination.decisions.length > 0 && <Disclosure title={`Your decisions (${coordination.decisions.length})`}>
          {[...coordination.decisions].reverse().map((d) => <ResultRow key={d.id} spec={d.action === "accept" ? MILESTONE_STATUS.accepted : SENT_BACK}
            title={`You ${d.action === "accept" ? "accepted" : "sent back"} ${relative(d.createdAt)} (${new Date(d.createdAt).toLocaleString()})`} detail={d.reason} />)}
        </Disclosure>}
        <Disclosure title={`Everything your coding tool has sent back (${coordination.reports.length})`}>
          {coordination.reports.map((r) => <Stack key={r.id} gap={4}><Small strong>{`Sent back ${new Date(r.createdAt).toLocaleString()}`}</Small><Code>{JSON.stringify(r.report, null, 2)}</Code></Stack>)}
          {!coordination.reports.length && <Muted>Nothing sent back yet.</Muted>}
        </Disclosure>
      </Disclosure>
    </Panel>}

    {coordination.contract && coordination.contract.prerequisites.length > 0 && <Panel title="Waiting on people" spec={progress.unresolved.length ? WAITING : SORTED} count={progress.unresolved.length} note={`${progress.unresolved.length} outstanding`}>
      <Disclosure title="Things you need from people" defaultOpen={step.kind === "unblock"}>
        {coordination.contract.prerequisites.map((p, i) => {
          const id = `p${i}`;
          const sorted = coordination.resolutions[id];
          return <ResultRow key={id} spec={sorted ? SORTED : WAITING} title={`${p.owner}: ${p.text}`} detail={sorted ? `Sorted, by your note: ${sorted}` : undefined}>
            {!sorted && <Stack gap={8}>
              <TextField label="How it got sorted" value={proof[id] ?? ""} onChangeText={(value) => setProof({ ...proof, [id]: value })} maxLength={2000} multiline editable={!locked} />
              <Button title="Mark this sorted" icon={Check} disabled={locked || !proof[id]?.trim()} onPress={() => void run("resolve", { prerequisiteId: id, evidence: proof[id] }, "Saved. Work that was waiting on this can move.")} />
            </Stack>}
          </ResultRow>;
        })}
        {feedback}
      </Disclosure>
    </Panel>}

    {showForms && <Panel title="What counts as finished" spec={NEXT_STEP.scope}
      actions={<Button title={scopeOpen ? "Hide" : "Show"} variant="subtle" compact accessibilityLabel={`${scopeOpen ? "Hide" : "Show"} what counts as finished`} onPress={() => setScopeOpen(!scopeOpen)} />}>
      {scopeOpen && <>
        <Muted>Two to twelve things you could watch happen. Keep them plain: what someone can do, not how it's built.</Muted>
        <TextField label="What does done look like, in one line" value={contract.outcome} maxLength={4000} onChangeText={(outcome) => setContract({ ...contract, outcome })} editable={!locked} />
        <TextField label="Not doing (one per line)" value={contract.exclusions.join("\n")} maxLength={12000} multiline onChangeText={(value) => setContract({ ...contract, exclusions: value.split("\n") })} editable={!locked} />
        {contract.criteria.map((c, i) => <Stack gap={6} key={`criterion-${i}`}>
          <TextField label={`Thing ${i + 1} I could watch happen`} value={c.text} maxLength={2000} editable={!locked}
            onChangeText={(value) => setContract({ ...contract, criteria: contract.criteria.map((x, n) => n === i ? { ...x, text: value } : x) })} />
          <SelectField label={`Which piece of work proves thing ${i + 1}`} options={criteriaDestinations} value={destinationValue(c.milestones)} disabled={locked}
            onChange={(value) => setContract({ ...contract, criteria: contract.criteria.map((x, n) => n === i ? { ...x, milestones: destinationFrom(value) } : x) })} />
        </Stack>)}
        <Button title="Add another" icon={Plus} disabled={locked || contract.criteria.length >= 12} onPress={() => setContract({ ...contract, criteria: [...contract.criteria, { text: "", milestones: [] }] })} />
        {contract.prerequisites.map((p, i) => <Stack gap={6} key={`prerequisite-${i}`}>
          <TextField label={`Thing ${i + 1} you need from a person`} value={p.text} maxLength={2000} editable={!locked}
            onChangeText={(value) => setContract({ ...contract, prerequisites: contract.prerequisites.map((x, n) => n === i ? { ...x, text: value } : x) })} />
          <TextField label="Who you need it from" value={p.owner} maxLength={200} editable={!locked}
            onChangeText={(value) => setContract({ ...contract, prerequisites: contract.prerequisites.map((x, n) => n === i ? { ...x, owner: value } : x) })} />
          <SelectField label="What it holds up" options={prerequisiteDestinations} value={destinationValue(p.milestones)} disabled={locked}
            onChange={(value) => setContract({ ...contract, prerequisites: contract.prerequisites.map((x, n) => n === i ? { ...x, milestones: destinationFrom(value) } : x) })} />
        </Stack>)}
        <Button title="Add something you need from a person" icon={Plus} disabled={locked || contract.prerequisites.length >= 12} onPress={() => setContract({ ...contract, prerequisites: [...contract.prerequisites, { text: "", owner: "", milestones: [] }] })} />
        {(coordination.contract || plan) && <Toggle label="Replace what I had before. Work already accepted will need checking again." value={replaceConfirmed} onValueChange={setReplaceConfirmed} disabled={locked} />}
        {feedback}
        <Button title="Save this" variant="primary" loading={busy} disabled={locked || !state.goal || (!!(coordination.contract || plan) && !replaceConfirmed)}
          onPress={() => void run("contract", { contract: { outcome: contract.outcome, criteria: contract.criteria, prerequisites: contract.prerequisites, exclusions: contract.exclusions.filter((x) => x.trim()) } }, "Saved. Next, break the work into pieces.").then((ok) => { if (ok) setReplaceConfirmed(false); })} />
      </>}
    </Panel>}

    {showForms && coordination.contract && <Panel title="Break the work into pieces" spec={NEXT_STEP.plan}
      actions={<Button title={planOpen ? "Hide" : "Show"} variant="subtle" compact accessibilityLabel={`${planOpen ? "Hide" : "Show"} break the work into pieces`} onPress={() => setPlanOpen(!planOpen)} />}>
      {planOpen && <>
        <Muted>Send this to your coding tool. It reads the code and proposes the pieces; paste its answer back. Nothing is decided until you save it.</Muted>
        {!copyError && <><Small strong>Prompt to send</Small><Code>{planning}</Code><CopyButton text={planning} label="Copy prompt" /></>}
        <TextField label="Paste milestone plan JSON" value={planText} onChangeText={(value) => { setPlanText(value); setPlanReviewed(false); }} maxLength={64000} multiline editable={!locked} autoCapitalize="none" autoCorrect={false} />
        {planPreview ? <><Small strong>Parsed pieces for review</Small><Code>{planPreview}</Code>
          <Toggle label="I read these pieces and the order they go in" value={planReviewed} onValueChange={setPlanReviewed} /></> : null}
        {plan && <Toggle label="Replace the old pieces. Old results stay, but the new work needs fresh proof." value={replaceConfirmed} onValueChange={setReplaceConfirmed} disabled={locked} />}
        {feedback}
        <Button title="Save these pieces" variant="primary" loading={busy} disabled={locked || !planText.trim() || !planReviewed || (!!plan && !replaceConfirmed)}
          onPress={() => void run("plan", { plan: planText }, "Saved. Your first piece of work is at the top.").then((ok) => { if (ok) { setPlanText(""); setReplaceConfirmed(false); } })} />
      </>}
    </Panel>}
  </>;
}
