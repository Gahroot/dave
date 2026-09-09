import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Checkbox, Group, NativeSelect, Stack, Text, Textarea, TextInput, Title } from "@mantine/core";
import type { PortfolioProject } from "../../shared/types.ts";
import type { DeliveryGoal, DeliveryState } from "../../model/delivery-schema.ts";
import type { DeliveryContextPacket, ContextCategory } from "../../model/delivery-context.ts";
import type { GenerationOperation } from "../../model/delivery-planner.ts";
import { deliveryAssignment } from "../delivery-handoff.ts";
import { deliveryApi, DeliveryRequestError } from "../delivery-api.ts";
import { CopyText } from "../components/CopyText.tsx";

type Result = { state?: DeliveryState; operation?: GenerationOperation | null; recovery?: string | null };
const initialGoal: DeliveryGoal = { goal: "Daily usability", intendedUser: "", workflow: "", stage: "", provider: null, model: null, consent: null };
const categories: ContextCategory[] = ["goal", "documents", "manifest", "entrypoints", "coverage", "history"];
const documents = ["README.md", "PRODUCT.md", "SCOPE.md", "BRIEF.md", "SPEC.md", "ARCHITECTURE.md", "docs/PRODUCT.md", "docs/ARCHITECTURE.md"];
export function DeliveryView({ project, today = false }: { project: PortfolioProject; today?: boolean }) {
  const base = `/api/projects/${encodeURIComponent(project.id)}/delivery`;
  const [state, setState] = useState<DeliveryState | null>(null);
  const [operation, setOperation] = useState<GenerationOperation | null>(null);
  const [goal, setGoal] = useState<DeliveryGoal>(initialGoal);
  const initialized = useRef(false);
  const settingsTouched = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [selection, setSelection] = useState<ContextCategory[]>(["goal"]);
  const [docs, setDocs] = useState<string[]>([]);
  const [contextDirty, setContextDirty] = useState(false);
  const [preview, setPreview] = useState<{ packet: DeliveryContextPacket; expectedRevision: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [outcome, setOutcome] = useState("");
  const [evidence, setEvidence] = useState("");
  const [reason, setReason] = useState("");
  const completion = useRef<{ id: string; revision: number; key: string; report: { outcome: string; evidence: string } } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const accept = (result: Result) => {
    if (result.state) { setState(result.state); if (!initialized.current) { setGoal(result.state.goal ?? initialGoal); initialized.current = true; } }
    if (result.operation !== undefined) setOperation(result.operation);
    if (result.recovery) { setNotice(result.recovery); setPreview(null); setContextDirty(true); }
  };
  const load = async () => {
    try {
      const result = await deliveryApi<Result>(base);
      accept(result); setError("");
      if (!result.state?.goal && !settingsTouched.current) {
        const connected = await deliveryApi<{ openai: { state: string } }>("/api/providers");
        if (connected.openai.state === "connected" && !settingsTouched.current) {
          setGoal(current => current.provider ? current : { ...current, provider: "openai", model: "gpt-6-astra" });
        }
      }
    }
    catch (e) { setError(e instanceof Error ? e.message : "Delivery state unavailable. Reload latest saved state."); }
  };
  useEffect(() => { void load(); }, [base]);
  useEffect(() => {
    if (operation?.status !== "pending") return;
    let active = true;
    const timer = window.setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const next = await deliveryApi<GenerationOperation>(`${base}/operations/${operation.id}`);
        if (!active) return;
        setOperation(next);
        if (next.status !== "pending") { await load(); setNotice(`Planning ${next.status}${next.error ? `: ${next.error}. Review a new context preview before retrying.` : "."}`); }
      } catch { if (active) setError("Could not read planning status. Reload latest saved state; do not start another request to check progress."); }
    }, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [base, operation?.id, operation?.status]);
  const run = async (path: string, body: object = {}, success?: (result: Result) => void) => {
    if (!state || lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { const result = await deliveryApi<Result>(`${base}/${path}`, { expectedRevision: state.revision, ...body }); accept(result); success?.(result); }
    catch (e) {
      if (e instanceof DeliveryRequestError && e.state) setState(e.state);
      if (e instanceof DeliveryRequestError && e.status === 409) { setPreview(null); setContextDirty(true); if (!e.state) await load(); }
      setError(e instanceof Error ? e.message : "Not saved. Your draft is retained; retry when ready.");
    } finally { lock.current = false; setBusy(false); }
  };
  const plan = state?.plans.find(p => p.id === state.currentPlanId);
  const milestone = plan?.milestones.find(m => m.id === state?.currentMilestoneId);
  const pending = operation?.status === "pending";
  const exhausted = !!plan && plan.milestones.every(m => m.status === "reported-complete");
  let assignment = "", assignmentError = "";
  if (plan && milestone) {
    try { assignment = deliveryAssignment({ projectName: project.name, projectPath: project.canonicalPath, projectId: project.id, goal: plan.goal, plan, milestone, history: state?.history }); }
    catch (e) { assignmentError = e instanceof Error ? e.message : "Task unavailable"; }
  }
  const updateGoal = (patch: Partial<DeliveryGoal>) => { settingsTouched.current = true; setGoal(g => ({ ...g, ...patch, consent: null })); setDirty(true); setPreview(null); };
  const complete = () => {
    if (!state || (!milestone && !completion.current)) return;
    completion.current ??= { id: milestone!.id, revision: state.revision, key: crypto.randomUUID(), report: { outcome, evidence } };
    const saved = completion.current;
    void run(`${encodeURIComponent(saved.id)}/complete`, { expectedRevision: saved.revision, idempotencyKey: saved.key, report: saved.report }, result => {
      completion.current = null; setOutcome(""); setEvidence("");
      setNotice(result.recovery ?? "Reported complete saved. The next saved milestone is shown below; this is not independent verification.");
      window.requestAnimationFrame(() => heading.current?.focus());
    });
  };
  return <Card withBorder radius="md" padding="md"><Stack gap="sm">
    <Title order={2}>{today ? "Today's project milestone" : "Delivery plan"}</Title>
    <Group justify="space-between"><Text fw={600}>{project.name}</Text><Button component="a" variant="default" href={today ? `#projects?id=${encodeURIComponent(project.id)}` : "#connections"}>{today ? "Project details and setup" : "Connections"}</Button></Group>
    {error && <Alert color="red" title="Action needs attention" role="alert">{error}</Alert>}
    <Text role="status">{notice}</Text>
    <Button variant="default" disabled={busy} onClick={() => void load()}>Reload latest saved state</Button>
    {!state && <Text>Loading saved delivery state. If it stays unavailable, use Reload latest saved state.</Text>}
    {state && <>
      <Title order={3} ref={heading} tabIndex={-1}>{milestone?.title ?? (exhausted ? "Saved milestone queue exhausted" : plan ? "No eligible milestone: review prerequisites" : "No delivery milestone yet")}</Title>
      {milestone ? <>
        <Text size="lg">{milestone.outcome}</Text><Text>Status: {milestone.status}</Text><Text><strong>Why now:</strong> {milestone.whyNow}</Text>
        {milestone.blockedReason && <Alert title="Blocked prerequisite">{milestone.blockedReason}</Alert>}
        <details><summary>Scope, acceptance and prerequisites</summary><Stack gap="xs">{([['Included scope', milestone.scope], ['Acceptance criteria', milestone.acceptance], ['Exclusions', milestone.exclusions], ['Human prerequisites', milestone.humanPrerequisites], ['Source references', milestone.sourceIds], ['Assumptions', plan!.assumptions]] as [string, string[]][]).map(([label, values]) => <div key={label}><Text fw={600}>{label}</Text><ul>{values.map((v, i) => <li key={i}>{v}</li>)}</ul></div>)}<Text>Dependencies: {milestone.dependencies.map(i => plan!.milestones[i]?.title).join("; ") || "None saved"}</Text></Stack></details>
        {assignmentError ? <Alert color="red">{assignmentError}</Alert> : <><CopyText text={assignment} label="Copy task for EZ Coder" /><details><summary>Preview exact EZ Coder task</summary><Textarea label="Exact task text" value={assignment} readOnly autosize minRows={5} maxRows={16} /></details></>}
        <details><summary>Complete and continue: user-reported outcome</summary><Stack gap="sm" mt="sm">
          <Text>This saves your report, not independent proof, client acceptance or launch readiness. Copying does not complete work. Exhaustion may attempt one approved next-plan request; changed context requires fresh approval.</Text>
          <Textarea label="Delivered outcome" maxLength={4000} value={outcome} disabled={!!completion.current || busy} onChange={e => setOutcome(e.currentTarget.value)} autosize minRows={2} />
          <Textarea label="Runtime/test evidence, unverified claims and remaining blockers" maxLength={8000} value={evidence} disabled={!!completion.current || busy} onChange={e => setEvidence(e.currentTarget.value)} autosize minRows={3} />
          {completion.current && <Text>A submission is retained for an exact, idempotent retry. Reload checks saved state without discarding it.</Text>}
          <Button disabled={busy || pending || milestone.status !== "pending" || !outcome.trim() || !evidence.trim()} onClick={complete}>Complete and continue</Button>

        </Stack></details>
      </> : <Text>{plan && !exhausted ? "Work remains blocked or depends on incomplete milestones. Review the saved statuses and exact prerequisites below; reopen explicitly when ready." : plan ? "Completion history remains saved. Review and approve a fresh context packet, then Generate the next plan. No recommendation is fabricated." : "Set a delivery goal and select a connected provider/model in project details, then preview and approve context. Saved four-question notes are not a milestone."}</Text>}
      {completion.current && <Group><Button variant="default" disabled={busy || pending} onClick={complete}>Retry original completion</Button><Button variant="default" disabled={busy || pending} onClick={() => { completion.current = null; setNotice("Original retry released. Review the latest milestone and retained report before submitting a new completion."); }}>Release original retry after reviewing saved state</Button></Group>}
      <details><summary>Block, reopen, next milestones and history</summary><Stack gap="sm" mt="sm">
        <Textarea label="Exact prerequisite or reason to reopen" value={reason} onChange={e => setReason(e.currentTarget.value)} maxLength={2000} autosize />
        {milestone?.status === "pending" && <Button variant="default" disabled={busy || pending || !reason.trim()} onClick={() => void run(`${milestone.id}/block`, { reason }, () => setReason(""))}>Block current milestone</Button>}
        {plan?.milestones.map(m => <div key={m.id}><Text fw={600}>{m.position + 1}. {m.title}</Text><Text>{m.status}{m.blockedReason ? `: ${m.blockedReason}` : ""}</Text>{m.status !== "pending" && <Button variant="default" disabled={busy || pending || !reason.trim()} onClick={() => void run(`${m.id}/reopen`, { reason }, () => { setReason(""); window.requestAnimationFrame(() => heading.current?.focus()); })}>Reopen {m.title}</Button>}</div>)}
        {state.history.map(event => <div key={event.id}><Text>{event.kind === "complete" ? "Reported complete" : event.kind} · {event.source} · {new Date(event.createdAt).toLocaleString()}</Text><Text style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(event.detail, null, 2)}</Text></div>)}
        {!state.history.length && <Text>No saved delivery history.</Text>}
      </Stack></details>
      {operation && <Text role="status">Planning: {operation.status}{operation.error ? ` · ${operation.error}. Review a fresh preview and retry explicitly.` : ""}</Text>}
      {pending && <Button variant="default" disabled={busy} onClick={() => void run("cancel", { operationId: operation!.id })}>Cancel planning</Button>}
      {!today && <>
        <details open={!state.goal}><summary>Delivery goal and planning setup</summary><Stack gap="sm" mt="sm" data-summary-editing={dirty || undefined}>
          <Text>Saving settings invalidates prior context approval. Form drafts stay here on errors or conflicts.</Text>
          {([['goal', 'Delivery goal'], ['intendedUser', 'Intended user'], ['workflow', 'Target daily workflow'], ['stage', 'Current stage and unknowns']] as const).map(([key, label]) => <TextInput key={key} label={label} value={goal[key]} maxLength={key === 'goal' || key === 'workflow' ? 4000 : 1000} disabled={busy || pending} onChange={e => updateGoal({ [key]: e.currentTarget.value })} />)}
          <NativeSelect label="Planning provider" value={goal.provider ?? ""} disabled={busy || pending} onChange={e => updateGoal({ provider: (e.currentTarget.value || null) as DeliveryGoal['provider'], model: null })} data={[{ value: "", label: "Select provider" }, { value: "openai", label: "OpenAI subscription" }, { value: "claude", label: "Anthropic / Claude: unavailable" }]} />
          <NativeSelect label="Exact planning model" value={goal.model ?? ""} disabled={busy || pending} onChange={e => updateGoal({ model: e.currentTarget.value || null })} data={[{ value: "", label: "Select model" }, ...(goal.provider === "openai" ? ["gpt-6-astra"] : goal.provider === "claude" ? ["claude-fable-5-1", "claude-opus-5"] : [])]} />
          {goal.provider === "claude" && <Text>Claude planning unavailable: subscription-compatible isolation from managed hooks has not been verified. No API fallback. See Connections.</Text>}
          <Button disabled={busy || pending || !goal.goal.trim() || !goal.intendedUser.trim() || !goal.workflow.trim() || !goal.stage.trim() || !goal.provider || !goal.model} onClick={() => void run("goal", { goal: { ...goal, consent: null } }, () => { setDirty(false); setPreview(null); setNotice("Goal saved. Select context and collect a local preview."); })}>Save delivery settings</Button>
        </Stack></details>
        <details open={!state.goal?.consent}><summary>Context selection and external-send approval</summary><Stack gap="sm" mt="sm">
          <Text>Select bounded local context. Preview reads selected files locally, not externally. Review for private information before approving. No task lists, credentials, raw transcripts, client data or bulk source export.</Text>
          {categories.map(category => <Checkbox key={category} label={category === "goal" ? "Goal (required)" : category} checked={selection.includes(category)} disabled={category === "goal" || busy || pending} onChange={e => { const checked = e.currentTarget.checked; setSelection(s => checked ? [...s, category] : s.filter(c => c !== category)); setPreview(null); setContextDirty(true); }} />)}
          {selection.includes("documents") && documents.map(doc => <Checkbox key={doc} label={doc} checked={docs.includes(doc)} disabled={busy || pending} onChange={e => { const checked = e.currentTarget.checked; setDocs(s => checked ? [...s, doc] : s.filter(d => d !== doc)); setPreview(null); setContextDirty(true); }} />)}
          <Button variant="default" disabled={busy || pending || dirty || !state.goal?.model || project.override.hidden} onClick={async () => {
            if (lock.current) return; lock.current = true; setBusy(true); setError(""); setPreview(null); setContextDirty(true);
            try { setPreview(await deliveryApi(`${base}/context/preview`, { expectedRevision: state.revision, permissions: { collect: true, categories: selection, documents: selection.includes("documents") ? docs : [] } })); }
            catch (e) { if (e instanceof DeliveryRequestError && e.state) setState(e.state); setError(e instanceof Error ? e.message : "Preview failed. Retry."); }
            finally { lock.current = false; setBusy(false); }
          }}>Collect local preview</Button>
          {dirty && <Text>Save your changed delivery settings before previewing.</Text>}
          {project.override.hidden && <Text>Unhide this project in its notes options before planning.</Text>}
          {preview && <><Text fw={600}>External destination: {preview.packet.provider} / {preview.packet.model}</Text><Textarea label="Exact context packet for approval" readOnly value={JSON.stringify(preview.packet, null, 2)} autosize minRows={6} maxRows={18} /><Button disabled={busy || pending || dirty || preview.expectedRevision !== state.revision} onClick={() => void run("context/approve", { fingerprint: preview.packet.fingerprint }, () => { setContextDirty(false); setNotice("Exact context approved. Generate or Replan sends it to the selected provider."); })}>Approve this exact packet for external planning</Button></>}
          <Text>Approval: {contextDirty ? "Fresh preview and approval required for your selection or changed context." : state.goal?.consent ? "Saved for the exact packet and model. Changes require a new preview." : "Not approved"}</Text>
          <Group><Button disabled={busy || pending || dirty || contextDirty || !state.goal?.consent || state.goal.provider !== "openai"} onClick={() => void run("generate")}>{plan && !milestone ? "Generate next plan / retry" : "Generate plan"}</Button>{plan && <Button variant="default" disabled={busy || pending || dirty || contextDirty || !state.goal?.consent || state.goal.provider !== "openai"} onClick={() => void run("replan")}>Replan explicitly</Button>}</Group>
          <Button component="a" variant="default" href="#connections">Set up or repair provider connection</Button>
        </Stack></details>
      </>}
    </>}
  </Stack></Card>;
}
