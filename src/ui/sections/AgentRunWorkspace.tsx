import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Checkbox, Group, NativeSelect, Stack, Tabs, Text, Textarea, Title } from "@mantine/core";
import { Square } from "lucide-react";
import { ACTIVE, type AgentRun, type RunEvent, type PacketSummary, type ReviewPacket } from "../../agents/types.ts";
import { deliveryApi } from "../delivery-api.ts";
import { useDraftGuard } from "../hooks/useDraftGuard.ts";
import { parseRoute, routeLink } from "../navigation.ts";
import { NextActionRow } from "../components/WorkspacePrimitives.tsx";

export const RUN_LABELS: Record<AgentRun["status"], string> = { queued: "Queued", starting: "Preparing workspace", running: "Working", waiting: "Needs permission", review: "Review or reply", checking: "Running checks", accepted: "Accepted, not merged", failed: "Failed", stopped: "Stopped", interrupted: "Disconnected" };
const errorText = (error: unknown) => error instanceof Error ? error.message : "Request failed. Your draft is retained.";
function EvidenceHistory({ id, history }: { id: string; history: PacketSummary[] }) {
  const [selected, setSelected] = useState(""), [packet, setPacket] = useState<ReviewPacket | null>(null), [error, setError] = useState("");
  useEffect(() => {
    setPacket(null); setError(""); if (!selected) return;
    const ac = new AbortController();
    void deliveryApi<ReviewPacket>(`/api/agents/runs/${id}/evidence/${selected}`, undefined, ac.signal).then(value => { if (!ac.signal.aborted) setPacket(value); }).catch(error => { if (!ac.signal.aborted) setError(errorText(error)); });
    return () => ac.abort();
  }, [id, selected]);
  if (!history.length) return null;
  return <details><summary>Retained evidence history ({history.length})</summary><Stack mt="sm" gap="sm"><Text size="sm">Historical snapshots do not prove the current workspace still passes.</Text><NativeSelect label="Previous review packet" value={selected} onChange={e => setSelected(e.currentTarget.value)} data={[{ value: "", label: "Choose a recorded snapshot" }, ...history.map(h => ({ value: String(h.id), label: `Turn ${h.turn}, ${h.createdAt}` }))]} />{error && <Alert color="red" role="alert">{error}</Alert>}{selected && !packet && !error && <Text role="status">Loading recorded evidence…</Text>}{packet && <pre className="agent-output" role="region" tabIndex={0} aria-label="Historical evidence">{JSON.stringify(packet, null, 2)}</pre>}</Stack></details>;
}
export function AgentRunWorkspace({ id, polling, refresh, onSaved, returnTo }: { id: string; polling: boolean; refresh: number; onSaved: () => void; returnTo: string | null }) {
  const [run, setRun] = useState<AgentRun | null>(null), [events, setEvents] = useState<RunEvent[]>([]), [error, setError] = useState("");
  const [message, setMessage] = useState(""), [confirmed, setConfirmed] = useState<string[]>([]), [stopped, setStopped] = useState(false), [manual, setManual] = useState(false), [busy, setBusy] = useState(false);
  const cursor = useRef(0), lock = useRef(false), heading = useRef<HTMLHeadingElement>(null);
  const [connectionError, setConnectionError] = useState(""), [history, setHistory] = useState<PacketSummary[]>([]);
  useDraftGuard(!!message, hash => parseRoute(hash).runId === id);
  const runFilter = parseRoute(location.hash).runFilter;
  const listHref = routeLink("agents", { filter: runFilter === "all" ? null : runFilter, return: returnTo });
  const restoreListFocus = () => requestAnimationFrame(() => document.getElementById(`agent-row-${id}`)?.focus());
  useEffect(() => { heading.current?.focus(); }, [run?.id]);
  useEffect(() => {
    const ac = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        if (document.visibilityState !== "visible") return;
        const value = await deliveryApi<{ run: AgentRun; events: RunEvent[]; history: PacketSummary[] }>(`/api/agents/runs/${id}?after=${cursor.current}`, undefined, ac.signal);
        if (!ac.signal.aborted) { setRun(value.run); setHistory(value.history); setConnectionError(""); if (value.events.length) { cursor.current = value.events.at(-1)!.seq; setEvents(old => [...old, ...value.events].slice(-500)); } }
      } catch(error) { if (!ac.signal.aborted) setConnectionError(errorText(error)); }
      finally { if (!ac.signal.aborted && polling) timer = setTimeout(load, 2000); }
    }
    void load(); return () => { ac.abort(); clearTimeout(timer); };
  }, [id, polling, refresh]);
  useEffect(() => { setConfirmed([]); setManual(false); }, [run?.packet?.fingerprint, run?.turn]);
  async function action(action: string, extra: object = {}) {
    if (!run || lock.current) return; lock.current = true; setBusy(true); setError("");
    try { const value = await deliveryApi<AgentRun>(`/api/agents/runs/${id}/actions`, { action, revision: run.revision, message, reason: message, fingerprint: run.packet?.fingerprint, confirmCriteria: confirmed.length === run.criteria.length, acknowledgeNoChecks: manual, confirmStopped: stopped, ...extra }); setRun(value); onSaved(); if (["reply", "retry", "accept", "dismiss"].includes(action)) setMessage(""); }
    catch(error) { setError(errorText(error)); } finally { setBusy(false); lock.current = false; }
  }
  if (!run) return <Stack><Button component="a" href={listHref} variant="default" onClick={restoreListFocus}>All runs</Button>{connectionError ? <Alert color="red" role="alert">{connectionError}</Alert> : <Text role="status">Loading run…</Text>}</Stack>;
  return <Stack gap="md">
    <Group><Button component="a" href={listHref} variant="default" onClick={restoreListFocus}>All runs</Button>{returnTo && <Button component="a" href={returnTo} variant="default">Return to inbox context</Button>}</Group>
    {connectionError && <Alert title="Run updates unavailable" color="red" role="alert">{connectionError} Last loaded state may be stale.</Alert>}
    {error && <Alert title="Action unavailable" color="red" role="alert">{error}</Alert>}
    <NextActionRow state={run.projectName} title={<Title order={3} ref={heading} tabIndex={-1}>{run.title}</Title>} action={<Badge variant="outline">{RUN_LABELS[run.status]}</Badge>}><Text>{run.reason || RUN_LABELS[run.status]}</Text></NextActionRow>
    {run.handoffId && <Button component="a" href={`#queue?delivery=${encodeURIComponent(run.projectId)}`} variant="default">Open linked delivery and milestone review</Button>}
    {(ACTIVE.includes(run.status) || run.status === "queued") && <Button color="red" variant="outline" leftSection={<Square size={16} />} loading={busy} onClick={() => void action("stop")}>Stop run (keep workspace)</Button>}
    {run.permission && <Alert title="Agent needs your permission"><Stack><Text>{run.permission.title}</Text><Group>{run.permission.options.map(option => <Button key={option.optionId} disabled={busy} onClick={() => void action("permission", { optionId: option.optionId })}>{option.name}</Button>)}<Button variant="default" disabled={busy} onClick={() => void action("permission", { optionId: null })}>Deny request</Button></Group></Stack></Alert>}
    <Tabs defaultValue={run.status === "review" ? "changes" : "activity"} keepMounted>
      <Tabs.List aria-label="Run evidence"><Tabs.Tab value="activity">Activity</Tabs.Tab><Tabs.Tab value="changes">Changes</Tabs.Tab><Tabs.Tab value="checks">Checks</Tabs.Tab></Tabs.List>
      <Tabs.Panel value="activity" pt="md"><Text size="sm">Latest 500 events; output is capped and common credential patterns are redacted. Agent text is not verified evidence.</Text><pre className="agent-output" role="region" tabIndex={0} aria-label="Agent activity">{events.map(event => event.kind === "output" ? event.text : `\n[${event.kind}] ${event.text}\n`).join("") || "No activity yet."}</pre></Tabs.Panel>
      <Tabs.Panel value="changes" pt="md">{run.packet ? <><Text size="sm">{run.packet.files.length} changed files. Captured {run.packet.capturedAt}.</Text><details><summary>Changed-file metadata</summary><ul>{run.packet.files.map(file => <li key={file}>{file}</li>)}</ul></details><pre className="agent-output" role="region" tabIndex={0} aria-label="Workspace diff">{run.packet.diff || "No file changes."}</pre></> : <Text>No evidence packet captured yet.</Text>}</Tabs.Panel>
      <Tabs.Panel value="checks" pt="md"><Stack gap="sm">{run.packet ? <><Text size="sm">Checks refer to revision fingerprint: {run.packet.fingerprint}</Text>{run.packet.checks.map((check, index) => <details key={index}><summary>{check.label}: {check.exitCode === 0 ? "passed" : `failed (${check.exitCode ?? "interrupted"})`}</summary><pre className="agent-output" role="region" aria-label={`${check.label} output`} tabIndex={0}>{check.output || "No output."}</pre></details>)}</> : <Text>No check evidence yet.</Text>}</Stack></Tabs.Panel>
    </Tabs>
    {run.status === "review" && <Group><Button variant="default" disabled={busy} onClick={() => void action("refresh")}>Refresh evidence (invalidates previous checks)</Button><Button variant="default" disabled={busy || !run.packet || !run.checks.length} onClick={() => void action("check")}>Run approved checks</Button></Group>}
    {["review", "failed", "stopped", "interrupted"].includes(run.status) && <section aria-label="Run review actions"><Stack gap="sm">
      {run.status === "review" && <><Text fw={600}>Review packet</Text><Text size="sm">{run.packet ? `${run.packet.checks.filter(check => check.exitCode === 0).length} passing / ${run.checks.length} configured checks` : "Evidence is unavailable"}</Text>{run.packet && <>{!run.checks.length && <Checkbox label="No automated checks are configured; I performed and describe the manual verification below" checked={manual} onChange={e => setManual(e.currentTarget.checked)} />}{run.criteria.map((criterion, index) => <Checkbox key={index} label={`I verified: ${criterion}`} checked={confirmed.includes(String(index))} onChange={e => setConfirmed(e.currentTarget.checked ? [...confirmed, String(index)] : confirmed.filter(value => value !== String(index)))} />)}</>}</>}
      <Textarea label="Reply, requested changes, or acceptance evidence" description="Feedback resumes the same conversation and workspace. Acceptance does not commit, merge or deploy anything." value={message} maxLength={16000} onChange={e => setMessage(e.currentTarget.value)} autosize minRows={3} />
      {run.status === "interrupted" && <Checkbox label="I confirmed no previous agent is still working in this workspace" checked={stopped} onChange={e => setStopped(e.currentTarget.checked)} />}
      <Group className="form-actions"><Button variant="default" disabled={busy || !message.trim() || (run.status === "interrupted" && !stopped)} onClick={() => void action(run.status === "review" ? "reply" : "retry")}>{run.status === "review" ? "Reply / request changes" : "Retry with this instruction"}</Button><Button variant="default" disabled={busy || !message.trim()} onClick={() => void action("dismiss")}>Close without accepting</Button>{run.status === "review" && <Button disabled={busy || !message.trim() || !run.packet || confirmed.length !== run.criteria.length || (run.checks.length ? run.packet?.checks.length !== run.checks.length || run.packet.checks.some(check => check.exitCode !== 0) : !manual)} onClick={() => void action("accept")}>Accept reviewed work</Button>}</Group>
    </Stack></section>}
    <details><summary>Workspace and session diagnostics</summary><Text size="sm">Turn {run.turn} · {run.sessionId ? `Session ${run.sessionId}` : "Session not started"}</Text>{run.workspace && <Text size="sm">Workspace: {run.workspace}<br />Branch: {run.branch}</Text>}</details>
    <EvidenceHistory id={id} history={history} />
  </Stack>;
}
