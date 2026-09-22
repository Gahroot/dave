import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { WorkspaceShell } from "./components/WorkspaceShell.tsx";
import { RefreshCw as IconRefresh } from "lucide-react";
import type { AttentionAction, Portfolio, ProjectSummary } from "../shared/types.ts";
import { TodayView } from "./sections/TodayView.tsx";
import { ProjectsView } from "./sections/ProjectsView.tsx";
import { CopyText } from "./components/CopyText.tsx";

import { ConnectionsView } from "./sections/ConnectionsView.tsx";
import { Issues } from "./sections/Issues.tsx";

import { handoff, relative } from "./format.ts";
import { parseRoute } from "./navigation.ts";

const AgentPlatform = lazy(() => import("./sections/AgentPlatform.tsx").then(m => ({ default: m.AgentPlatform })));

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000), headers: init?.body ? { "content-type": "application/json" } : undefined });
  if (!res.ok) throw new Error(`Request failed (${res.status}). Retry when ready.`);
  return await res.json() as T;
}

export function App() {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [pending, setPending] = useState<Portfolio | null>(null);
  const loading = useRef<Promise<void> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const saving = useRef(false);
  const lastLoad = useRef(0);
  const [route, setRoute] = useState(() => window.location.hash);
  const [, params = ""] = route.slice(1).split("?");
  const navigation = parseRoute(route);
  const tab = navigation.destination;
  const query = new URLSearchParams(params);
  const projectRoute = tab === "connections" && navigation.returnTo?.startsWith("#projects") ? navigation.returnTo : route;
  const projectNavigation = parseRoute(projectRoute);
  useEffect(() => {
    const navigate = () => setRoute(window.location.hash);
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, []);
  useEffect(() => {
    const id = new URLSearchParams(params).get("item");
    if (tab === "queue" && id) document.getElementById(`destination-${id}`)?.focus();
  }, [route, tab, params]);
  const load = useCallback((fresh: boolean, background = false): Promise<void> => {
    if (loading.current) return loading.current;
    if (background && (saving.current || Date.now() - lastLoad.current < 60_000)) return Promise.resolve();
    const abort = new AbortController();
    controller.current = abort;
    lastLoad.current = Date.now();
    setBusy(true);
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; abort.abort(); }, 30_000);
    loading.current = (async () => {
      try {
        const next = await api<Portfolio>(fresh ? "/api/refresh" : "/api/portfolio", { method: fresh ? "POST" : "GET", signal: abort.signal });
        if (document.querySelector("[data-summary-editing]") || (background && document.activeElement?.closest("[data-attention-id], textarea"))) setPending(next);
        else { setPortfolio(next); setPending(null); }
        setError(null);
      } catch (e) { if (timedOut) setError("Update timed out. Saved content is unchanged; retry when ready."); else if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "Update failed"); }
      finally { window.clearTimeout(timeout); loading.current = null; setBusy(false); }
    })();
    return loading.current;
  }, []);
  useEffect(() => {
    let disposed = false;
    void Promise.resolve().then(() => { if (!disposed) void load(false); });
    return () => { disposed = true; controller.current?.abort(); };
  }, [load]);
  useEffect(() => {
    if (paused) return;
    let disposed = false;
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      if (!disposed && document.visibilityState === "visible") {
        timer = window.setTimeout(refreshVisible, Math.max(1000, 60_000 - (Date.now() - lastLoad.current)));
      }
    };
    const refreshVisible = () => {
      window.clearTimeout(timer);
      if (document.visibilityState === "visible") void load(false, true).finally(schedule);
    };
    schedule();
    document.addEventListener("visibilitychange", refreshVisible);
    window.addEventListener("focus", refreshVisible);
    return () => { disposed = true; window.clearTimeout(timer); document.removeEventListener("visibilitychange", refreshVisible); window.removeEventListener("focus", refreshVisible); };
  }, [load, paused]);

  const resolve = async (id: string, action: AttentionAction): Promise<boolean> => {
    if (saving.current) return false;
    saving.current = true;
    setBusyId(id);
    try {
      await loading.current;
      setPending(null);
      const result = await api<{ portfolio: Portfolio }>(`/api/attention/${id}/${action}`, { method: "POST" });
      setPortfolio(result.portfolio);
      setError(null);
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : "Action failed"); return false; }
    finally { saving.current = false; setBusyId(null); }
  };
  const seen = useCallback((ids: string[]) => {
    void api("/api/attention/seen", { method: "POST", body: JSON.stringify({ ids }) })
      .catch(() => setError("Could not remember which items you viewed. Retry the update."));
  }, []);
  const act = async (id: string, url: string, body: unknown) => {
    if (saving.current) return;
    saving.current = true;
    setBusyId(id);
    try { await loading.current; setPending(null); await api(url, { method: "POST", body: JSON.stringify(body) }); await load(true); }
    catch (e) { setError(e instanceof Error ? e.message : "Action failed"); }
    finally { saving.current = false; setBusyId(null); }
  };
  const overrideProject = (id: string, next: { pinned?: boolean; hidden?: boolean }) => void act(id, `/api/projects/${id}/override`, next);
  const correctSummary = async (id: string, field: string, value: string): Promise<ProjectSummary | null> => {
    if (saving.current) return null;
    saving.current = true;
    setBusyId(id);
    try {
      await loading.current;
      const { summary } = await api<{ summary: ProjectSummary }>(`/api/projects/${id}/summary`, { method: "POST", body: JSON.stringify({ [field]: value }) });
      setPortfolio((current) => {
        if (!current) return current;
        const patch = (projects: Portfolio["active"]) => projects.map((p) => p.id === id ? { ...p, summary } : p);
        return { ...current, active: patch(current.active), other: patch(current.other), hidden: patch(current.hidden) };
      });
      setPending(null);
      setError(null);
      void load(true);
      return summary;
    } catch (e) { setError(e instanceof Error ? e.message : "Save failed"); return null; }
    finally { saving.current = false; setBusyId(null); }
  };

  return <WorkspaceShell destination={tab} actions={<Group gap="md" justify="flex-end" className="workspace-toolbar">
    <Text size="sm" c="dimmed">Updated {relative(portfolio?.generatedAt ?? null)}</Text>
    <Group gap="xs"><Button variant="subtle" color="dark" disabled={!!busyId} leftSection={<IconRefresh size={14} aria-hidden="true" />} loading={busy} onClick={() => void load(true)}>Refresh</Button><Button variant="subtle" color="dark" aria-pressed={paused} onClick={() => setPaused(v => !v)}>{paused ? "Resume auto-updates" : "Pause auto-updates"}</Button></Group>
  </Group>}>
        <Stack gap="md">
          {(error || portfolio?.stale) && <Alert color="red" title="Showing saved information" role="alert">{error ?? portfolio?.refreshError}<Button variant="default" ml="xs" onClick={() => void load(true)}>Retry</Button></Alert>}
          {pending && <Alert color="gray" title="Updated information is ready" role="status">Your focused item has stayed in place.<Button variant="default" onClick={() => { if (!document.querySelector("[data-summary-editing]")) { setPortfolio(pending); setPending(null); } }}>Apply update</Button></Alert>}
          {(navigation.invalidSelection || navigation.invalidRun) && <Alert title="Invalid destination" role="alert">This link does not identify available work. Choose an item from the directory.</Alert>}
          {!portfolio && <Text role="status">{busy ? "Loading your portfolio…" : "No snapshot loaded."}</Text>}
          {tab === "connections" && <ConnectionsView />}
          {tab === "agents" && <Suspense fallback={<Text role="status">Loading agent desk…</Text>}><AgentPlatform paused={paused} /></Suspense>}
          {portfolio && <>
            {tab === "queue" && <>
              <TodayView route={route} paused={paused} portfolio={portfolio} busyId={busyId} onResolve={resolve} onSeen={seen} actions={(item) => {
                const p = [...portfolio.active, ...portfolio.other, ...portfolio.hidden].find((p) => p.id === item.projectId);
                return p ? <Group align="flex-start" gap="xs">
                  <Button component="a" href={`#projects?id=${encodeURIComponent(p.id)}`} variant="default" id={`destination-${item.id}`}
                    onClick={() => window.history.replaceState(null, "", `#queue?item=${encodeURIComponent(item.id)}`)}>View project</Button>
                  <CopyText text={p.canonicalPath} label="Copy path" /><CopyText text={handoff(p, item)} label="Copy handoff" />
                </Group> : <Text size="sm">Project context unavailable; retained evidence may be stale.</Text>;
              }} />
            </>}
            {projectNavigation.destination === "projects" && <div hidden={tab !== "projects"}><ProjectsView items={portfolio.inbox} projects={[...portfolio.active, ...portfolio.other, ...portfolio.hidden]} query={projectNavigation.q} selectedId={projectNavigation.id} waiting={projectNavigation.waiting} route={projectRoute}
              onSearch={(value) => { const next = new URLSearchParams(params); next.set("q", value); const hash = `#projects?${next}`; window.history.replaceState(null, "", hash); setRoute(hash); }}
              busyId={busyId} onOverride={overrideProject} onCorrect={correctSummary} /></div>}
            {tab === "issues" && <Issues issues={portfolio.issues} coverage={portfolio.coverage} />}
          </>}
        </Stack>
  </WorkspaceShell>;
}
