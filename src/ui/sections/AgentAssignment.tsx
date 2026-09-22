import { useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Group, NativeSelect, Stack, Text, Textarea, TextInput, Title } from "@mantine/core";
import { parseChecks, type AgentOverview, type AgentRun, type CheckCommand } from "../../agents/types.ts";
import { deliveryApi } from "../delivery-api.ts";
import { parseRoute, routeLink } from "../navigation.ts";
import { useDraftGuard } from "../hooks/useDraftGuard.ts";

export function AgentAssignment({ data, projectId, handoffId }: { data: AgentOverview; projectId: string; handoffId: string | null }) {
  const [project, setProject] = useState(projectId), [title, setTitle] = useState(""), [prompt, setPrompt] = useState(""), [criteria, setCriteria] = useState("");
  const [checks, setChecks] = useState<CheckCommand[]>([]), [deps, setDeps] = useState<string[]>([]), [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [ready, setReady] = useState(!handoffId), [stage, setStage] = useState(0);
  const retry = useRef<{ body: string; key: string } | null>(null), lock = useRef(false), submitted = useRef(false);
  useDraftGuard(!!title || !!prompt || !!criteria || !!checks.length || !!deps.length, hash => { const route = parseRoute(hash); return submitted.current || route.destination === "agents" && route.view === "new" && route.project === (projectId || null) && route.handoff === handoffId; });
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
      submitted.current = true; location.hash = routeLink("agents", {}, run.id);
    } catch(e) { setError(e instanceof Error ? e.message : "Not queued. Your draft is retained."); } finally { setBusy(false); lock.current = false; }
  };
  return <Stack gap="md" className="form-stage">
    <Title order={3}>{["Assignment", "Checks and dependencies", "Review and start"][stage]}</Title><Text size="sm">Step {stage + 1} of 3</Text>
    {error && <Alert color="red" role="alert" title="Not queued">{error}</Alert>}
    <Stack hidden={stage !== 0} gap="sm">
      <NativeSelect label="Project" data={[{ value: "", label: "Choose a project" }, ...data.projects.map(p => ({ value: p.id, label: p.name }))]} value={project} disabled={!!handoffId || busy} onChange={e => { setProject(e.currentTarget.value); setAck(false); }} />
      <TextInput label="Outcome in one line" value={title} maxLength={200} disabled={!!handoffId || busy} onChange={e => { setTitle(e.currentTarget.value); setAck(false); }} />
      <Textarea label="Assignment" value={prompt} maxLength={24000} readOnly={!!handoffId} disabled={busy} onChange={e => { setPrompt(e.currentTarget.value); setAck(false); }} autosize minRows={3} maxRows={10} />
      <Textarea label="What proves it is done (one criterion per line)" description="Up to 12 criteria, 2,000 characters each." value={criteria} maxLength={12000} readOnly={!!handoffId} disabled={busy} onChange={e => { setCriteria(e.currentTarget.value); setAck(false); }} autosize minRows={2} />
    </Stack>
    <Stack hidden={stage !== 1} gap="sm">
      <Text>Checks run an executable with separate arguments, not a shell command. No checks means explicit manual review.</Text>
      {checks.map((check, index) => <fieldset key={index}><legend>Check {index + 1}</legend><Stack gap="xs">
        <TextInput label={`Check ${index + 1} label`} maxLength={120} value={check.label} onChange={e => changeCheck(index, { label: e.currentTarget.value })} />
        <TextInput label={`Check ${index + 1} executable`} description="For example: npm" maxLength={500} value={check.command} onChange={e => changeCheck(index, { command: e.currentTarget.value })} />
        {check.args.map((arg, ai) => <Group align="flex-end" key={ai}><TextInput label={`Check ${index + 1} argument ${ai + 1}`} value={arg} maxLength={2000} onChange={e => { const value = e.currentTarget.value; changeCheck(index, { args: check.args.map((old, i) => ai === i ? value : old) }); }} /><Button variant="default" onClick={() => changeCheck(index, { args: check.args.filter((_, i) => i !== ai) })}>Remove argument {ai + 1}</Button></Group>)}
        <Group><Button variant="default" disabled={check.args.length >= 30} onClick={() => changeCheck(index, { args: [...check.args, ""] })}>Add argument</Button><Button variant="default" onClick={() => { setChecks(values => values.filter((_, i) => i !== index)); setAck(false); }}>Remove check {index + 1}</Button></Group>
      </Stack></fieldset>)}
      <Button variant="default" disabled={checks.length >= 6} onClick={() => { setChecks(values => [...values, { label: "", command: "", args: [] }]); setAck(false); }}>Add check</Button>
      {checksError && <Text c="red">{checksError}</Text>}
      <details><summary>Wait for other assignments</summary><Stack gap="xs" mt="sm">{data.runs.filter(r => r.status !== "accepted" && r.status !== "stopped").slice(0, 30).map(r => <Checkbox key={r.id} label={`${r.projectName}: ${r.title}`} checked={deps.includes(r.id)} disabled={!deps.includes(r.id) && deps.length >= 12} onChange={e => { setDeps(e.currentTarget.checked ? [...deps, r.id] : deps.filter(id => id !== r.id)); setAck(false); }} />)}<Text size="sm">Dependencies must be accepted before this run starts. Acceptance does not merge code between workspaces.</Text></Stack></details>
    </Stack>
    <Stack hidden={stage !== 2} gap="sm">
      <Text fw={600}>{data.projects.find(p => p.id === project)?.name}: {title}</Text><Text style={{ whiteSpace: "pre-wrap" }}>{prompt}</Text><ul>{criterionList.map((value, i) => <li key={i}>{value}</li>)}</ul>
      <pre className="agent-output" aria-label="Approved check commands" tabIndex={0}>{JSON.stringify(checks, null, 2)}</pre><Text>{deps.length} dependencies · {handoffId ? "Linked delivery handoff" : "Standalone assignment"}</Text>{!!deps.length && <ul>{deps.map(id => <li key={id}>{data.runs.find(run => run.id === id)?.title ?? id}</li>)}</ul>}
      <Alert title="Local execution">Agents and approved checks can access your machine and network and may incur provider charges. A worktree separates files, not permissions.</Alert>
      <Text size="sm">The original checkout must be clean. DAVE does not copy uncommitted files, install dependencies, or share generated files between workspaces.</Text>
      {!data.settings.enabled && <Alert title="Execution is disabled">Save this decision explicitly in <a href="#agents?view=settings">execution settings</a> before starting work.</Alert>}
      <Checkbox label="I authorize this assignment and these checks to run locally using my agent account" checked={ack} onChange={e => setAck(e.currentTarget.checked)} />
    </Stack>
    <Group className="form-actions"><Button component="a" href="#agents" variant="default">Cancel</Button>{stage > 0 && <Button variant="default" disabled={busy} onClick={() => setStage(s => s - 1)}>Back</Button>}{stage < 2 ? <Button disabled={!validAssignment || stage === 1 && !!checksError} onClick={() => setStage(s => s + 1)}>Continue</Button> : <Button disabled={!validAssignment || !!checksError || !data.settings.enabled || !ack} loading={busy} onClick={() => void submit()}>Queue assignment</Button>}</Group>
  </Stack>;
}
