import { useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Group, NativeSelect, Stack, Text, Textarea, TextInput, Title } from "@mantine/core";
import { ArrowLeft, ArrowRight, CircleCheck, CircleDashed, CircleDot, ListChecks, Play, Plus, Terminal, TriangleAlert, X } from "lucide-react";
import { parseChecks, type AgentOverview, type AgentRun, type CheckCommand } from "../../agents/types.ts";
import { StatusIcon } from "../components/Status.tsx";
import type { StatusSpec } from "../status.ts";

const STAGES = ["Assignment", "Checks and dependencies", "Review and start"] as const;
const DONE: StatusSpec = { tone: "green", icon: CircleCheck, label: "Done" };
const CURRENT: StatusSpec = { tone: "blue", icon: CircleDot, label: "Current" };
const TODO: StatusSpec = { tone: "gray", icon: CircleDashed, label: "To do" };
import { deliveryApi } from "../delivery-api.ts";
import { parseRoute, routeLink } from "../navigation.ts";
import { useDraftGuard } from "../hooks/useDraftGuard.ts";

export function AgentAssignment({ data, projectId, handoffId, meetingItemId = null }: { data: AgentOverview; projectId: string; handoffId: string | null; meetingItemId?: string | null }) {
  const [project, setProject] = useState(projectId), [title, setTitle] = useState(""), [prompt, setPrompt] = useState(""), [criteria, setCriteria] = useState("");
  const [checks, setChecks] = useState<CheckCommand[]>([]), [deps, setDeps] = useState<string[]>([]), [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [ready, setReady] = useState(!handoffId && !meetingItemId), [stage, setStage] = useState(0);
  const retry = useRef<{ body: string; key: string } | null>(null), lock = useRef(false), submitted = useRef(false);
  useDraftGuard(!!title || !!prompt || !!criteria || !!checks.length || !!deps.length, hash => { const route = parseRoute(hash); return submitted.current || route.destination === "agents" && route.view === "new" && route.project === (projectId || null) && route.handoff === handoffId && route.meetingItem === meetingItemId; });
  // A client idea from a meeting fills an editable draft; nothing is queued until the owner starts it.
  useEffect(() => {
    if (!meetingItemId || handoffId) return;
    const ac = new AbortController();
    void deliveryApi<{ projectId: string; title: string; prompt: string; criteria: string[] }>(`/api/meetings/items/${encodeURIComponent(meetingItemId)}/assignment`, undefined, ac.signal).then(v => { if (!ac.signal.aborted) { setProject(v.projectId); setTitle(v.title); setPrompt(v.prompt); setCriteria(v.criteria.join("\n")); setReady(true); } }).catch(e => { if (!ac.signal.aborted) setError(e instanceof Error ? e.message : "Draft unavailable"); });
    return () => ac.abort();
  }, [meetingItemId, handoffId]);
  useEffect(() => {
    if (!handoffId) return;
    const ac = new AbortController();
    void deliveryApi<{ title: string; prompt: string; criteria: string[] }>(`/api/agents/delivery/${encodeURIComponent(projectId)}/${encodeURIComponent(handoffId)}`, undefined, ac.signal).then(v => { if (!ac.signal.aborted) { setTitle(v.title); setPrompt(v.prompt); setCriteria(v.criteria.join("\n")); setReady(true); } }).catch(e => { if (!ac.signal.aborted) setError(e instanceof Error ? e.message : "Assignment unavailable"); });
    return () => ac.abort();
  }, [handoffId, projectId]);
  const criterionList = criteria.split("\n").filter(value => value.trim());
  const validAssignment = ready && !!project && !!title.trim() && !!prompt.trim() && criterionList.length > 0 && criterionList.length <= 12 && criterionList.every(value => value.length <= 2000);
  let checksError = "";
  try { parseChecks(checks); } catch (error) { checksError = error instanceof Error ? error.message : "Check the command fields"; }
  const changeCheck = (index: number, patch: Partial<CheckCommand>) => { setChecks(values => values.map((value, i) => i === index ? { ...value, ...patch } : value)); setAck(false); };
  const submit = async () => {
    if (lock.current) return; lock.current = true; setBusy(true); setError("");
    try {
      const value = { projectId: project, title, prompt, criteria: criterionList, checks: parseChecks(checks), dependencies: deps, handoffId, authorizeExecution: ack };
      const body = JSON.stringify(value); if (retry.current?.body !== body) retry.current = { body, key: crypto.randomUUID() };
      const run = await deliveryApi<AgentRun>("/api/agents/runs", { ...value, requestKey: retry.current.key });
      if (meetingItemId) {
        // Same request key on retry: the server returns the same run, so only the link is retried.
        try { await deliveryApi(`/api/meetings/items/${encodeURIComponent(meetingItemId)}/link`, { runId: run.id }); }
        catch (e) { throw new Error(`Queued, but not yet linked to the client idea: ${e instanceof Error ? e.message : "request failed"} Select Queue assignment again to retry the link; no second run is created.`); }
      }
      submitted.current = true; location.hash = routeLink("agents", {}, run.id);
    } catch(e) { setError(e instanceof Error ? e.message : "Not queued. Your draft is retained."); } finally { setBusy(false); lock.current = false; }
  };
  return <Stack gap="md" className="form-stage">
    <ol className="step-dots" aria-label={`Step ${stage + 1} of 3`}>{STAGES.map((label, index) => <li key={label} data-state={index < stage ? "done" : index === stage ? "current" : "todo"} aria-current={index === stage ? "step" : undefined}><StatusIcon spec={index < stage ? DONE : index === stage ? CURRENT : TODO} />{label}</li>)}</ol>
    <Title order={3}>{STAGES[stage]}</Title>
    {error && <Alert color="red" role="alert" title="Not queued">{error}</Alert>}
    <Stack hidden={stage !== 0} gap="sm">
      <NativeSelect label="Project" data={[{ value: "", label: "Choose a project" }, ...data.projects.map(p => ({ value: p.id, label: p.name }))]} value={project} disabled={!!handoffId || busy} onChange={e => { setProject(e.currentTarget.value); setAck(false); }} />
      <TextInput label="Outcome in one line" value={title} maxLength={200} disabled={!!handoffId || busy} onChange={e => { setTitle(e.currentTarget.value); setAck(false); }} />
      <Textarea label="Assignment" value={prompt} maxLength={24000} readOnly={!!handoffId} disabled={busy} onChange={e => { setPrompt(e.currentTarget.value); setAck(false); }} autosize minRows={3} maxRows={10} />
      <Textarea label="What proves it is done (one criterion per line)" description="Up to 12 criteria, 2,000 characters each." value={criteria} maxLength={12000} readOnly={!!handoffId} disabled={busy} onChange={e => { setCriteria(e.currentTarget.value); setAck(false); }} autosize minRows={2} />
    </Stack>
    <Stack hidden={stage !== 1} gap="sm">
      <Text size="sm" c="dimmed">Checks run an executable with separate arguments, not a shell command. No checks means explicit manual review.</Text>
      {checks.map((check, index) => <fieldset key={index}><legend>Check {index + 1}</legend><Stack gap="xs">
        <TextInput label={`Check ${index + 1} label`} maxLength={120} value={check.label} onChange={e => changeCheck(index, { label: e.currentTarget.value })} />
        <TextInput label={`Check ${index + 1} executable`} description="For example: npm" maxLength={500} value={check.command} onChange={e => changeCheck(index, { command: e.currentTarget.value })} />
        {check.args.map((arg, ai) => <Group align="flex-end" key={ai}><TextInput label={`Check ${index + 1} argument ${ai + 1}`} value={arg} maxLength={2000} onChange={e => { const value = e.currentTarget.value; changeCheck(index, { args: check.args.map((old, i) => ai === i ? value : old) }); }} /><Button variant="subtle" color="red" onClick={() => changeCheck(index, { args: check.args.filter((_, i) => i !== ai) })}>Remove argument {ai + 1}</Button></Group>)}
        <Group gap="xs"><Button variant="default" leftSection={<Plus size={16} aria-hidden="true" />} disabled={check.args.length >= 30} onClick={() => changeCheck(index, { args: [...check.args, ""] })}>Add argument</Button><Button variant="subtle" color="red" leftSection={<X size={16} aria-hidden="true" />} onClick={() => { setChecks(values => values.filter((_, i) => i !== index)); setAck(false); }}>Remove check {index + 1}</Button></Group>
      </Stack></fieldset>)}
      <Button variant="default" leftSection={<Plus size={16} aria-hidden="true" />} disabled={checks.length >= 6} onClick={() => { setChecks(values => [...values, { label: "", command: "", args: [] }]); setAck(false); }}>Add check</Button>
      {checksError && <Text c="red" size="sm" className="inline-error"><TriangleAlert size={14} aria-hidden="true" /> {checksError}</Text>}
      <details><summary>Wait for other assignments</summary><Stack gap="xs" mt="sm">{data.runs.filter(r => r.status !== "accepted" && r.status !== "stopped").slice(0, 30).map(r => <Checkbox key={r.id} label={`${r.projectName}: ${r.title}`} checked={deps.includes(r.id)} disabled={!deps.includes(r.id) && deps.length >= 12} onChange={e => { setDeps(e.currentTarget.checked ? [...deps, r.id] : deps.filter(id => id !== r.id)); setAck(false); }} />)}<Text size="sm">Dependencies must be accepted before this run starts. Acceptance does not merge code between workspaces.</Text></Stack></details>
    </Stack>
    <Stack hidden={stage !== 2} gap="sm">
      <div className="review-summary">
        <p className="section-label">{data.projects.find(p => p.id === project)?.name}</p>
        <Text fw={600} size="lg">{title}</Text>
        <Text size="sm" c="dimmed">{deps.length} dependencies · {handoffId ? "Linked delivery handoff" : meetingItemId ? "From a client idea in a meeting" : "Standalone assignment"}</Text>
        <details className="quiet-details"><summary>Assignment text</summary><Text size="sm" style={{ whiteSpace: "pre-wrap" }}>{prompt}</Text></details>
      </div>
      <p className="section-label">Done when ({criterionList.length})</p>
      <ul className="result-list">{criterionList.map((value, i) => <li key={i} className="result-row"><StatusIcon spec={TODO} /><span className="result-row-title">{value}</span></li>)}</ul>
      <p className="section-label">Approved checks ({checks.length})</p>
      <ul className="result-list" aria-label="Approved check commands" tabIndex={0}>{checks.length ? checks.map((check, i) => <li key={i} className="result-row"><StatusIcon spec={{ tone: "blue", icon: Terminal, label: "" }} /><span className="result-row-title">{check.label || `Check ${i + 1}`}</span><code className="result-row-detail command-line">{[check.command, ...check.args.map(arg => JSON.stringify(arg))].join(" ")}</code></li>) : <li className="result-row"><StatusIcon spec={TODO} /><span className="result-row-title">No automated checks</span><span className="result-row-detail">You will verify manually before accepting.</span></li>}</ul>
      {!!deps.length && <><p className="section-label">Waits for ({deps.length})</p><ul className="result-list">{deps.map(id => <li key={id} className="result-row"><StatusIcon spec={{ tone: "gray", icon: ListChecks, label: "" }} /><span className="result-row-title">{data.runs.find(run => run.id === id)?.title ?? id}</span></li>)}</ul></>}
      <Alert color="orange" icon={<TriangleAlert size={18} aria-hidden="true" />} title="Local execution">Agents and approved checks can access your machine and network and may incur provider charges. A worktree separates files, not permissions. The original checkout must be clean. DAVE does not copy uncommitted files, install dependencies, or share generated files between workspaces.</Alert>
      {!data.settings.enabled && <Alert color="red" icon={<TriangleAlert size={18} aria-hidden="true" />} title="Execution is disabled">Save this decision explicitly in <a href="#agents?view=settings">execution settings</a> before starting work.</Alert>}
      <Checkbox label="I authorize this assignment and these checks to run locally using my agent account" checked={ack} onChange={e => setAck(e.currentTarget.checked)} />
    </Stack>
    <Group className="form-actions" gap="xs"><Button component="a" href="#agents" variant="subtle" color="dark">Cancel</Button>{stage > 0 && <Button variant="default" leftSection={<ArrowLeft size={16} aria-hidden="true" />} disabled={busy} onClick={() => setStage(s => s - 1)}>Back</Button>}{stage < 2 ? <Button className="action-primary" rightSection={<ArrowRight size={16} aria-hidden="true" />} disabled={!validAssignment || stage === 1 && !!checksError} onClick={() => setStage(s => s + 1)}>Continue</Button> : <Button className="action-primary" leftSection={<Play size={16} aria-hidden="true" />} disabled={!validAssignment || !!checksError || !data.settings.enabled || !ack} loading={busy} onClick={() => void submit()}>Queue assignment</Button>}</Group>
  </Stack>;
}
