import { useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Group, NumberInput, Stack, Text } from "@mantine/core";
import { RefreshCw } from "lucide-react";
import { ACTIVE, ATTENTION, type AgentOverview, type AgentSettings } from "../../agents/types.ts";
import { deliveryApi } from "../delivery-api.ts";
import { AgentAssignment } from "./AgentAssignment.tsx";
import { AgentRunWorkspace, RUN_LABELS } from "./AgentRunWorkspace.tsx";
import { parseRoute, routeLink } from "../navigation.ts";
import { useDraftGuard } from "../hooks/useDraftGuard.ts";
import { PageHeader, EmptyState } from "../components/WorkspacePrimitives.tsx";
const errorText = (error: unknown) => error instanceof Error ? error.message : "Request failed. Your draft is retained.";

export function AgentPlatform({ paused = false }: { paused?: boolean }) {
  const [data, setData] = useState<AgentOverview | null>(null), [error, setError] = useState("");
  const [route, setRoute] = useState(location.hash), [polling, setPolling] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const live = polling && !paused;
  useEffect(() => { const update = () => setRoute(location.hash); window.addEventListener("hashchange", update); return () => window.removeEventListener("hashchange", update); }, []);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try { if (document.visibilityState !== "visible") return; const value = await deliveryApi<AgentOverview>("/api/agents", undefined, controller.signal); if (!controller.signal.aborted) { setData(value); setError(""); } }
      catch(error) { if (!controller.signal.aborted) setError(errorText(error)); }
      finally { if (!controller.signal.aborted && live) timer = setTimeout(load, 2500); }
    }
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [refresh, live]);
  const navigation = parseRoute(route);
  const composer = navigation.view === "new" || !!navigation.handoff;
  const runs = data?.runs.filter(run => navigation.runFilter === "all" || navigation.runFilter === "attention" && ATTENTION.includes(run.status) || navigation.runFilter === "active" && ACTIVE.includes(run.status) || navigation.runFilter === "queued" && run.status === "queued" || navigation.runFilter === "finished" && ["accepted", "stopped"].includes(run.status)) ?? [];
  return <Stack gap="md" className="agent-desk" data-run-selected={!!navigation.runId}>
    <PageHeader title="Agent desk" actions={<Group className="desk-actions"><Button component="a" href="#agents?view=new">New assignment</Button><Button component="a" href="#agents?view=settings" variant="default">Execution settings</Button></Group>} />
    <Group><Checkbox label="Live updates" disabled={paused} checked={live} onChange={e => setPolling(e.currentTarget.checked)} /><Button variant="default" leftSection={<RefreshCw size={16} aria-hidden="true" />} onClick={() => setRefresh(value => value + 1)}>Refresh runs</Button></Group>
    {error && <Alert title="Connection unavailable" color="red" role="alert">{error} Last loaded state may be out of date.</Alert>}
    {!data && !error && <Text role="status">Loading runs…</Text>}
    {data && <>
      {navigation.view === "settings" ? <><Button component="a" href="#agents" variant="default">All runs</Button><RuntimeSettings initial={data.settings} onSaved={() => setRefresh(value => value + 1)} /></> : composer ? <AgentAssignment key={`${navigation.project}:${navigation.handoff}`} data={data} projectId={navigation.project ?? ""} handoffId={navigation.handoff} /> : <>
        <Text className="desk-summary" size="sm">{data.runs.filter(run => ATTENTION.includes(run.status)).length} need attention · {data.runs.filter(run => ACTIVE.includes(run.status)).length} active · {data.runs.filter(run => run.status === "queued").length} queued · Execution {data.settings.enabled ? data.settings.paused ? "paused" : "enabled" : "disabled"}</Text>
        <nav className="workspace-filter" aria-label="Run filters">{([['all', 'All'], ['attention', 'Needs attention'], ['active', 'Active'], ['queued', 'Queued'], ['finished', 'Finished']] as const).map(([filter, label]) => <a key={filter} href={routeLink("agents", { filter, return: navigation.returnTo }, navigation.runId)} aria-current={navigation.runFilter === filter ? "true" : undefined}>{label}</a>)}</nav>
        <div className={`workspace-split${navigation.runId || navigation.invalidRun ? " has-selection" : ""}`}>
          <div className="workspace-list" aria-label="Agent runs">{runs.map(run => <a key={run.id} id={`agent-row-${run.id}`} className="workspace-row" href={routeLink("agents", { filter: navigation.runFilter, return: navigation.returnTo }, run.id)} aria-current={run.id === navigation.runId ? "true" : undefined}><Text size="xs" c="dimmed">{run.projectName}</Text><Text fw={600}>{run.title}</Text><Text size="sm">{RUN_LABELS[run.status]}{run.reason ? `: ${run.reason}` : ""}</Text>{run.status === "queued" && <Text size="sm">Waiting for capacity, accepted dependencies, and a project slot.</Text>}</a>)}{!runs.length && <EmptyState title={data.runs.length ? "No runs match this filter" : "No agent runs yet"}>Start with one bounded assignment. Execution requires explicit authorization.</EmptyState>}</div>
          {navigation.runId ? <section className="workspace-detail" aria-label="Run workspace"><AgentRunWorkspace key={navigation.runId} id={navigation.runId} polling={live} refresh={refresh} onSaved={() => setRefresh(value => value + 1)} returnTo={navigation.returnTo} /></section> : <EmptyState title={navigation.invalidRun ? "This run link is invalid" : "Choose a run"} action={navigation.invalidRun ? <Button component="a" href="#agents" variant="default">All runs</Button> : undefined}>Inspect the response and evidence before accepting work.</EmptyState>}
        </div>
        {data.runs.length === 200 && <Text size="sm">Showing the latest 200 loaded runs, with unresolved work first.</Text>}
      </>}
    </>}
  </Stack>;
}
function RuntimeSettings({ initial, onSaved }: { initial: AgentSettings; onSaved: () => void }) {
  const [value, setValue] = useState(initial), [ack, setAck] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const saved = useRef(JSON.stringify(initial)), lock = useRef(false);
  useDraftGuard(JSON.stringify(value) !== saved.current, hash => { const route = parseRoute(hash); return route.destination === "agents" && route.view === "settings"; });
  const save = async () => { if (lock.current) return; lock.current = true; setBusy(true); setError(""); try { const s = await deliveryApi<AgentSettings>("/api/agents/settings", { ...value, acknowledgeRisk: ack }); saved.current = JSON.stringify(s); setValue(s); onSaved(); } catch(e) { setError(errorText(e)); } finally { setBusy(false); lock.current = false; } };
  return <details open={!initial.enabled}><summary>Execution {initial.enabled ? initial.paused ? "paused" : "enabled" : "disabled"} · limits and permissions</summary><Stack gap="sm" mt="sm">
    <Alert title="Runs use your local agent account">Agents and approved checks can execute commands and access your machine and network. They may incur provider charges. A worktree separates files, not permissions. EZCoder currently runs without approval prompts. No automatic commits, merges, deployments or workspace deletion are performed by DAVE.</Alert>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    <Checkbox label="Enable local agent execution" checked={value.enabled} onChange={e => setValue({ ...value, enabled: e.currentTarget.checked })} />
    <Checkbox label="Pause new starts (running work continues)" checked={value.paused} onChange={e => setValue({ ...value, paused: e.currentTarget.checked })} />
    <Group grow align="flex-start">{([["maxConcurrent", "Active runs across all projects", 6], ["maxPerProject", "Active runs per project", 3], ["reviewLimit", "Pause new starts at this review backlog", 12], ["timeoutMinutes", "Maximum minutes per agent turn", 120]] as const).map(([key,label,max]) => <NumberInput key={key} label={label} min={1} max={max} value={value[key]} onChange={v => setValue({ ...value, [key]: Number(v) })} />)}</Group>
    {!initial.enabled && <Checkbox label="I understand these agents are not sandboxed and may use my paid account" checked={ack} onChange={e => setAck(e.currentTarget.checked)} />}
    <Button loading={busy} disabled={value.enabled && !initial.enabled && !ack} onClick={() => void save()}>Save execution settings</Button>
  </Stack></details>;
}
