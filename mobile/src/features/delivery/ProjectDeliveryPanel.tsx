/**
 * Port of src/ui/sections/DeliveryView.tsx (API/state owner) and
 * LazyDeliveryView.tsx (load boundary). Embedded in the project workspace
 * (inside its ScrollView) and shown full screen by app/delivery/[project].tsx,
 * so it returns sibling Panels only.
 */
import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { ArrowRight, Check, LoaderCircle, RefreshCw, ShieldCheck, Sparkles, TriangleAlert } from "lucide-react-native";
import type { PortfolioProject } from "../../../../src/shared/types.ts";
import type { DeliveryGoal, DeliveryState } from "../../../../src/model/delivery-schema.ts";
import type { DeliveryContextPacket, ContextCategory } from "../../../../src/model/delivery-context.ts";
import type { CoordinationState } from "../../../../src/model/delivery-coordination.ts";
import { deliveryAssignment } from "../../../../src/ui/delivery-handoff.ts";
import { Banner, Body, Button, Code, CopyButton, Disclosure, Heading, Inline, LoadingState, Muted, Panel, SelectField, Small, Stack, TextField, Toggle, confirm, tick } from "../../ui/primitives";
import { StatusMark } from "../../ui/status";
import { DeliveryRequestError, useDeliveryApi } from "./api";
import { DeliveryCoordination, type Snapshot } from "./DeliveryCoordination";
import { DeliverySetup } from "./DeliverySetup";
import { useDraftGuard } from "./StagePanels";
import { CONTEXT_CATEGORIES, CONTEXT_DOCUMENTS, GOAL_FIELDS, INITIAL_GOAL, categoryLabel, goalComplete, type GenerationOperation, modelOptions, randomKey } from "./model";

type Result = { coordination?: CoordinationState; state?: DeliveryState; operation?: GenerationOperation | null; recovery?: string | null };
/** `refreshToken`: bump to re-read saved state (pull-to-refresh) without discarding drafts. */
type Props = { project: PortfolioProject; today?: boolean; refreshToken?: number };

class DeliveryLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() {
    if (this.state.failed) return <Panel title="Delivery">
      <Banner tone="red" title="Delivery workspace unavailable" message="The workspace could not load. Your saved work is unchanged."
        action={<Button title="Reload workspace" icon={RefreshCw} onPress={() => this.setState({ failed: false })} />} />
    </Panel>;
    return this.props.children;
  }
}

export function ProjectDeliveryPanel({ project, today, refreshToken }: Props) {
  return <DeliveryLoadBoundary><DeliveryView key={project.id} project={project} today={today ?? false} refreshToken={refreshToken ?? 0} /></DeliveryLoadBoundary>;
}

const PROVIDER_NONE = "none";
const MODEL_NONE = "none";

function DeliveryView({ project, today, refreshToken }: { project: PortfolioProject; today: boolean; refreshToken: number }) {
  const call = useDeliveryApi();
  const router = useRouter();
  const base = `/api/projects/${encodeURIComponent(project.id)}/delivery`;
  const [state, setState] = useState<DeliveryState | null>(null);
  const [coordination, setCoordination] = useState<CoordinationState | null>(null);
  const [operation, setOperation] = useState<GenerationOperation | null>(null);
  const [goal, setGoal] = useState<DeliveryGoal>(INITIAL_GOAL);
  const initialized = useRef(false);
  const settingsTouched = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [selection, setSelection] = useState<ContextCategory[]>(["goal"]);
  const [docs, setDocs] = useState<string[]>([]);
  const [contextDirty, setContextDirty] = useState(false);
  const [documentPath, setDocumentPath] = useState("");
  const [documentReview, setDocumentReview] = useState<{ path: string; text: string; reviewedSha256: string; excerptTruncated: boolean } | null>(null);
  const [reviewedDocuments, setReviewedDocuments] = useState<{ path: string; reviewedSha256: string }[]>([]);
  const [preview, setPreview] = useState<{ packet: DeliveryContextPacket; expectedRevision: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [outcome, setOutcome] = useState("");
  const [evidence, setEvidence] = useState("");
  const [reason, setReason] = useState("");
  const completion = useRef<{ id: string; revision: number; key: string; report: { outcome: string; evidence: string } } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  useDraftGuard(dirty || contextDirty || !!outcome || !!evidence || !!reason);

  const accept = (result: Result) => {
    if (result.coordination) setCoordination(result.coordination);
    if (result.state) { const next = result.state; setState(next); if (!initialized.current) { setGoal(next.goal ?? INITIAL_GOAL); initialized.current = true; } }
    if (result.operation !== undefined) setOperation(result.operation);
    if (result.recovery) { setNotice(result.recovery); setPreview(null); setContextDirty(true); }
  };
  const load = async () => {
    try {
      const result = await call<Result>(base);
      if (!alive.current) return;
      accept(result); setError(""); setLoadError(false);
      if (!result.state?.goal && !settingsTouched.current) {
        const connected = await call<{ openai: { state: string } }>("/api/providers");
        if (alive.current && connected.openai.state === "connected" && !settingsTouched.current) {
          setGoal((current) => current.provider ? current : { ...current, provider: "openai", model: "gpt-6-astra" });
        }
      }
    } catch (e) { if (alive.current) { setLoadError(true); setError(e instanceof Error ? e.message : "Delivery state unavailable. Reload latest saved state."); } }
  };
  const loadRef = useRef(load);
  loadRef.current = load;
  useFocusEffect(useCallback(() => { void loadRef.current(); }, [base]));
  useEffect(() => { if (refreshToken) void loadRef.current(); }, [refreshToken]);

  // Poll a pending planning operation every 2 s while the app is in front. Reading status never starts inference.
  useEffect(() => {
    if (operation?.status !== "pending") return;
    const id = operation.id;
    let active = true;
    const timer = setInterval(() => {
      if (AppState.currentState !== "active") return;
      void (async () => {
        try {
          const next = await call<GenerationOperation>(`${base}/operations/${encodeURIComponent(id)}`);
          if (!active) return;
          setOperation(next);
          if (next.status !== "pending") { await loadRef.current(); setNotice(`Planning ${next.status}${next.error ? `: ${next.error}. Review a new context preview before retrying.` : "."}`); }
        } catch { if (active) setError("Could not read planning status. Reload latest saved state; do not start another request to check progress."); }
      })();
    }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [base, call, operation?.id, operation?.status]);

  const run = async (path: string, body: object = {}, success?: (result: Result) => void) => {
    if (!state || lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const result = await call<Result>(`${base}/${path}`, { expectedRevision: state.revision, ...body });
      accept(result); if (result.state && !result.coordination) await load(); success?.(result); tick();
    } catch (e) {
      if (e instanceof DeliveryRequestError && e.state) setState(e.state);
      if (e instanceof DeliveryRequestError && e.status === 409) { setPreview(null); setContextDirty(true); if (!e.state) await load(); }
      setError(e instanceof Error ? e.message : "Not saved. Your draft is retained; retry when ready.");
    } finally { lock.current = false; setBusy(false); }
  };
  /** Local-only reads (preview, document review) share the lock but never mutate milestones. */
  const local = async (work: () => Promise<void>, fallback: string) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { await work(); }
    catch (e) { if (e instanceof DeliveryRequestError && e.state) setState(e.state); setError(e instanceof Error ? e.message : fallback); }
    finally { lock.current = false; setBusy(false); }
  };

  const plan = state?.plans.find((p) => p.id === state.currentPlanId);
  const milestone = plan?.milestones.find((m) => m.id === state?.currentMilestoneId);
  const pending = operation?.status === "pending";
  const exhausted = !!plan && plan.milestones.every((m) => m.status === "reported-complete");
  let assignment = "", assignmentError = "";
  if (plan && milestone) {
    try { assignment = deliveryAssignment({ projectName: project.name, projectPath: project.canonicalPath, projectId: project.id, goal: plan.goal, plan, milestone, history: state?.history }); }
    catch (e) { assignmentError = e instanceof Error ? e.message : "Task unavailable"; }
  }
  const updateGoal = (patch: Partial<DeliveryGoal>) => { settingsTouched.current = true; setGoal((g) => ({ ...g, ...patch, consent: null })); setDirty(true); setPreview(null); };
  const complete = () => {
    if (!state) return;
    if (!completion.current) {
      if (!milestone) return;
      completion.current = { id: milestone.id, revision: state.revision, key: randomKey(), report: { outcome, evidence } };
    }
    const saved = completion.current;
    void run(`${encodeURIComponent(saved.id)}/complete`, { expectedRevision: saved.revision, idempotencyKey: saved.key, report: saved.report }, (result) => {
      completion.current = null; setOutcome(""); setEvidence("");
      setNotice(result.recovery ?? "Reported complete saved. The next saved milestone is shown below; this is not independent verification.");
    });
  };
  const markContext = () => { setPreview(null); setContextDirty(true); };
  const generate = async (path: "generate" | "replan") => {
    const g = state?.goal;
    const ok = await confirm({ title: path === "replan" ? "Replan with the approved packet?" : "Generate plan with the approved packet?",
      message: `Sends only the approved packet to ${g?.provider ?? "the provider"} / ${g?.model ?? "model"}. It may use your paid account.`, confirmLabel: path === "replan" ? "Replan" : "Generate" });
    if (ok) void run(path);
  };

  const operationSpec = pending ? { tone: "blue" as const, icon: LoaderCircle, label: "", spin: true } : operation?.error ? { tone: "red" as const, icon: TriangleAlert, label: "" } : { tone: "green" as const, icon: Check, label: "" };
  const providerValue = goal.provider ?? PROVIDER_NONE;
  const providerOptions = [{ value: PROVIDER_NONE, label: "My own coding tool (nothing sent anywhere)" }, { value: "openai", label: "OpenAI subscription" },
    ...(goal.provider === "claude" ? [{ value: "claude", label: "Saved Claude selection (planning unsupported)" }] : [])];
  const modelValues = [{ value: MODEL_NONE, label: "Select model" }, ...modelOptions(goal.provider).map((m) => ({ value: m, label: m }))];
  const inputsLocked = busy || pending;

  return <>
    <Panel title={today ? `Delivery · ${project.name}` : "Delivery"}>
      {error ? <Banner tone="red" title="Action needs attention" message={error}
        action={<Button title="Retry delivery read" icon={RefreshCw} compact disabled={busy} onPress={() => void load()} />} /> : null}
      {notice ? <Banner tone="blue" title={notice} /> : null}
      {!state && (loadError ? <Muted>Saved delivery state is unavailable. Use Reload latest saved state.</Muted> : <LoadingState label="Loading saved delivery state. If it stays unavailable, use Reload latest saved state." />)}
      {operation && (pending || !coordination?.contract) && <StatusMark spec={operationSpec}>{`Planning: ${operation.status}${operation.error ? ` · ${operation.error}. Review a fresh preview and retry explicitly.` : ""}`}</StatusMark>}
      {pending && operation && <Button title="Cancel planning" variant="subtle" disabled={busy} onPress={() => void run("cancel", { operationId: operation.id })} />}
      <Inline>
        <Button title="Reload latest saved state" icon={RefreshCw} variant="subtle" disabled={busy} onPress={() => void load()} />
        {today && <Button title="Project details and setup" icon={ArrowRight} variant="subtle" onPress={() => router.push(`/project/${encodeURIComponent(project.id)}`)} />}
      </Inline>
    </Panel>

    {state && coordination && <DeliveryCoordination project={project} state={state} coordination={coordination} onSaved={(value: Snapshot) => accept(value)} today={today} disabled={busy || pending} />}

    {state && !coordination?.contract && <Panel title="Older milestone queue">
      <Disclosure title="Older milestone queue, from before finish lines">
        <Heading>{milestone?.title ?? (exhausted ? "Saved milestone queue exhausted" : plan ? "No eligible milestone: review prerequisites" : "No delivery milestone yet")}</Heading>
        {milestone && plan ? <>
          <Body selectable>{milestone.outcome}</Body>
          <Small>Status: {milestone.status}</Small>
          <Small selectable><Small strong>Why now: </Small>{milestone.whyNow}</Small>
          {milestone.blockedReason ? <Banner tone="amber" title="Blocked prerequisite" message={milestone.blockedReason} /> : null}
          <Disclosure title="Scope, acceptance and prerequisites">
            {([["Included scope", milestone.scope], ["Acceptance criteria", milestone.acceptance], ["Exclusions", milestone.exclusions], ["Human prerequisites", milestone.humanPrerequisites], ["Source references", milestone.sourceIds], ["Assumptions", plan.assumptions]] as const).map(([label, values]) =>
              <Stack key={label} gap={2}><Small strong>{label}</Small>{values.map((v, i) => <Small key={i} selectable>{`• ${v}`}</Small>)}</Stack>)}
            <Small>Dependencies: {milestone.dependencies.map((i) => plan.milestones[i]?.title).join("; ") || "None saved"}</Small>
          </Disclosure>
          {assignmentError ? <Banner tone="red" title="Task unavailable" message={assignmentError} /> : <>
            <CopyButton text={assignment} label="Copy task for EZ Coder" />
            <Disclosure title="Preview exact EZ Coder task"><Code>{assignment}</Code></Disclosure>
          </>}
          <Disclosure title="Complete and continue: user-reported outcome">
            <Muted>This saves your report, not independent proof, client acceptance or launch readiness. Copying does not complete work. Exhaustion never starts model planning automatically. Adopt a bounded finish line above to review evidence before advancing.</Muted>
            <TextField label="Delivered outcome" maxLength={4000} multiline value={outcome} editable={!completion.current && !busy} onChangeText={setOutcome} />
            <TextField label="Runtime/test evidence, unverified claims and remaining blockers" maxLength={8000} multiline value={evidence} editable={!completion.current && !busy} onChangeText={setEvidence} />
            {completion.current && <Muted>A submission is retained for an exact, idempotent retry. Reload checks saved state without discarding it.</Muted>}
            <Button title="Complete and continue" variant="primary" loading={busy} disabled={busy || pending || milestone.status !== "pending" || !outcome.trim() || !evidence.trim()} onPress={complete} />
          </Disclosure>
        </> : <Muted>{plan && !exhausted ? "Work remains blocked or depends on incomplete milestones. Review the saved statuses and exact prerequisites below; reopen explicitly when ready." : plan ? "Completion history remains saved. Review and approve a fresh context packet, then Generate the next plan. No recommendation is fabricated." : "Set a delivery goal and select a connected provider/model in project details, then preview and approve context. Saved four-question notes are not a milestone."}</Muted>}
        {completion.current && <Stack gap={8}>
          <Button title="Retry original completion" disabled={busy || pending} onPress={complete} />
          <Button title="Release original retry after reviewing saved state" disabled={busy || pending} onPress={() => { completion.current = null; setNotice("Original retry released. Review the latest milestone and retained report before submitting a new completion."); }} />
        </Stack>}
        <Disclosure title="Block, reopen, next milestones and history">
          <TextField label="Exact prerequisite or reason to reopen" value={reason} onChangeText={setReason} maxLength={2000} multiline />
          {milestone?.status === "pending" && <Button title="Block current milestone" disabled={busy || pending || !reason.trim()} onPress={() => void run(`${encodeURIComponent(milestone.id)}/block`, { reason }, () => setReason(""))} />}
          {plan?.milestones.map((m) => <Stack key={m.id} gap={4}>
            <Small strong>{`${m.position + 1}. ${m.title}`}</Small>
            <Small>{`${m.status}${m.blockedReason ? `: ${m.blockedReason}` : ""}`}</Small>
            {m.status !== "pending" && <Button title={`Reopen ${m.title}`} compact disabled={busy || pending || !reason.trim()} onPress={() => void run(`${encodeURIComponent(m.id)}/reopen`, { reason }, () => setReason(""))} />}
          </Stack>)}
          {state.history.map((event) => <Stack key={event.id} gap={2}>
            <Small>{`${event.kind === "complete" ? "Reported complete" : event.kind} · ${event.source} · ${new Date(event.createdAt).toLocaleString()}`}</Small>
            <Code>{JSON.stringify(event.detail, null, 2)}</Code>
          </Stack>)}
          {!state.history.length && <Muted>No saved delivery history.</Muted>}
        </Disclosure>
      </Disclosure>
    </Panel>}

    {state && !today && <DeliverySetup manualOnly={!state.goal?.provider} hasGoal={!!state.goal && !dirty} hasPlan={!!plan || !!coordination?.contract} canReview={!!preview || !!state.goal?.consent}
      goal={<Stack gap={10}>
        {dirty && <Muted>Editing: unsaved delivery settings.</Muted>}
        {GOAL_FIELDS.map((field) => <TextField key={field.key} label={field.label} value={goal[field.key]} maxLength={field.maxLength} multiline={field.maxLength > 1000} editable={!inputsLocked}
          onChangeText={(value) => updateGoal({ [field.key]: value })} />)}
        <SelectField label="Who breaks the work into pieces" value={providerValue} options={providerOptions} disabled={inputsLocked}
          onChange={(value) => updateGoal({ provider: value === "openai" || value === "claude" ? value : null, model: null })} />
        <SelectField label="Which model" value={goal.model ?? MODEL_NONE} options={modelValues} disabled={inputsLocked}
          onChange={(value) => updateGoal({ model: value === MODEL_NONE ? null : value })} />
        <Button title="Set up or repair provider connection" icon={ArrowRight} variant="subtle" onPress={() => router.push("/connections")} />
        {goal.provider === "claude" && <Muted>Claude planning unavailable: subscription-compatible isolation from managed hooks has not been verified. No API fallback. See Connections.</Muted>}
        <Button title="Save delivery settings" icon={Check} variant="primary" loading={busy} disabled={inputsLocked || !goalComplete(goal)}
          onPress={() => void run("goal", { goal: { ...goal, consent: null } }, () => { setDirty(false); setPreview(null); setNotice("Saved. Next, say what finished looks like."); })} />
      </Stack>}
      context={<Stack gap={10}>
        <Muted>Select bounded local context. Preview reads selected files locally, not externally. Review for private information before approving. No task lists, credentials, raw transcripts, client data or bulk source export, except the meeting summary of client asks when you select meetings.</Muted>
        {CONTEXT_CATEGORIES.map((category) => <Toggle key={category} label={categoryLabel(category)} value={selection.includes(category)} disabled={category === "goal" || inputsLocked}
          onValueChange={(checked) => { setSelection((s) => checked ? [...s, category] : s.filter((c) => c !== category)); markContext(); }} />)}
        {selection.includes("documents") && CONTEXT_DOCUMENTS.map((doc) => <Toggle key={doc} label={doc} value={docs.includes(doc)} disabled={inputsLocked}
          onValueChange={(checked) => { setDocs((s) => checked ? [...s, doc] : s.filter((d) => d !== doc)); markContext(); }} />)}
        <Disclosure title="Review one additional product or operations document locally">
          <Muted>Explicit docs/ or doc/ Markdown paths only, up to three nested folders. Private, client, agent, task and credential files are excluded. Full review is limited to 8KB.</Muted>
          <TextField label="Selected document path" value={documentPath} maxLength={256} autoCapitalize="none" autoCorrect={false} onChangeText={(value) => { setDocumentPath(value); setDocumentReview(null); }} />
          <Button title="Read this selected document locally" disabled={inputsLocked || !documentPath.trim()}
            onPress={() => void local(async () => { setDocumentReview(await call(`${base}/document/review`, { expectedRevision: state.revision, path: documentPath })); }, "Local review failed")} />
          {documentReview && <>
            <Small strong>Full local document review</Small>
            <Code>{documentReview.text}</Code>
            {documentReview.excerptTruncated && <Muted>Model context would include only the first 4000 characters.</Muted>}
            <Button title="I reviewed this; include it in the next preview" disabled={reviewedDocuments.length >= 4}
              onPress={() => { const reviewed = documentReview; setReviewedDocuments((d) => [...d.filter((f) => f.path !== reviewed.path), { path: reviewed.path, reviewedSha256: reviewed.reviewedSha256 }]); setSelection((s) => s.includes("documents") ? s : [...s, "documents"]); markContext(); }} />
          </>}
          {reviewedDocuments.map((doc) => <Inline key={doc.path}><Small selectable>{doc.path}</Small>
            <Button title={`Remove ${doc.path}`} variant="danger-subtle" compact onPress={() => { setReviewedDocuments((d) => d.filter((f) => f.path !== doc.path)); markContext(); }} /></Inline>)}
        </Disclosure>
        <Button title="Collect local preview" loading={busy} disabled={inputsLocked || dirty || !state.goal?.model || project.override.hidden}
          onPress={() => { setPreview(null); setContextDirty(true); void local(async () => {
            setPreview(await call(`${base}/context/preview`, { expectedRevision: state.revision, permissions: { collect: true, categories: selection, documents: selection.includes("documents") ? docs : [], additionalFiles: selection.includes("documents") ? reviewedDocuments : [] } }));
          }, "Preview failed. Retry."); }} />
        {dirty && <Muted>Save your changed delivery settings before previewing.</Muted>}
        {project.override.hidden && <Muted>Unhide this project in its notes options before planning.</Muted>}
        {!state.goal?.provider && <Muted>Using another coding tool does not require external planning. Use the finish line and handoff controls above.</Muted>}
      </Stack>}
      review={<Stack gap={10}>
        <Small>Selected provider: {state.goal?.provider ?? "None"} / {state.goal?.model ?? "No model"}. Generation sends only the approved packet and may use your paid account.</Small>
        {preview && <>
          <Small strong>External destination: {preview.packet.provider} / {preview.packet.model}</Small>
          <Small strong>Exact context packet for approval</Small>
          <Code>{JSON.stringify(preview.packet, null, 2)}</Code>
          <Button title="Approve this exact packet for external planning" icon={ShieldCheck} variant="primary" disabled={busy || pending || dirty || preview.expectedRevision !== state.revision}
            onPress={() => void run("context/approve", { fingerprint: preview.packet.fingerprint }, () => { setContextDirty(false); setNotice("Exact context approved. Generate or Replan sends it to the selected provider."); })} />
        </>}
        <Small>Approval: {contextDirty ? "Fresh preview and approval required for your selection or changed context." : state.goal?.consent ? "Saved for the exact packet and model. Changes require a new preview." : "Not approved"}</Small>
        <Inline>
          <Button title={plan && !milestone ? "Generate next plan / retry" : "Generate plan"} icon={Sparkles} variant={preview ? "secondary" : "primary"}
            disabled={busy || pending || dirty || contextDirty || !state.goal?.consent || state.goal.provider !== "openai"} onPress={() => void generate("generate")} />
          {plan && <Button title="Replan explicitly" disabled={busy || pending || dirty || contextDirty || !state.goal?.consent || state.goal.provider !== "openai"} onPress={() => void generate("replan")} />}
        </Inline>
      </Stack>} />}
  </>;
}
