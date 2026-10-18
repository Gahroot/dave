import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { WorkspaceShell } from "./components/WorkspaceShell.tsx";
import { ArrowRight as IconOpen, CircleAlert as IconInvalid, CloudOff as IconStale, Pause as IconPause, Play as IconPlay, RefreshCw as IconRefresh, Sparkles as IconUpdate } from "lucide-react";
import type { AttentionAction, Portfolio, ProjectSummary } from "../shared/types.ts";
import { TodayView } from "./sections/TodayView.tsx";
import { ProjectsView } from "./sections/ProjectsView.tsx";
import { CopyText } from "./components/CopyText.tsx";

import { ConnectionsView } from "./sections/ConnectionsView.tsx";
import { Issues } from "./sections/Issues.tsx";

import { handoff, relative } from "./format.ts";
import { parseRoute, routeLink, safeReturn } from "./navigation.ts";
import { useWorkspaceReturn } from "./hooks/useWorkspaceReturn.ts";
import { DATA_CHANGED_EVENT, type DataChangedDetail } from "../voice/types.ts";
import { useVoice, VoiceProvider } from "./voice/VoiceProvider.tsx";
import { VoiceDock } from "./voice/VoiceDock.tsx";
import { triageApi } from "./triage-api.ts";

const AgentPlatform = lazy(() => import("./sections/AgentPlatform.tsx").then(m => ({ default: m.AgentPlatform })));
const MeetingsView = lazy(() => import("./sections/MeetingsView.tsx").then(m => ({ default: m.MeetingsView })));
const FocusRoute = lazy(() => import("./sections/focus/FocusView.tsx").then(m => ({ default: m.FocusRoute })));
const CleanupView = lazy(() => import("./sections/CleanupView.tsx").then(m => ({ default: m.CleanupView })));
const VoicePanel = lazy(() => import("./voice/VoicePanel.tsx").then(m => ({ default: m.VoicePanel })));

export function App() {
  return <VoiceProvider><Workspace /></VoiceProvider>;
}

/** Drawer and dock; the full-page panel renders on #voice instead. */
function VoiceLayer({ page }: { page: boolean }) {
  const voice = useVoice();
  if (page) return null;
  // The dock stays mounted (hidden) while the drawer is open, so closing the drawer can return focus to it.
  return <>
    <VoiceDock hidden={voice.open} />
    {voice.open && <Suspense fallback={null}><VoicePanel variant="drawer" /></Suspense>}
  </>;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000), headers: init?.body ? { "content-type": "application/json" } : undefined });
  if (!res.ok) throw new Error(`Request failed (${res.status}). Retry when ready.`);
  return await res.json() as T;
}

function Workspace() {
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
  const [cleanupCount, setCleanupCount] = useState<number | null>(null);
  useEffect(() => {
    // The nav pill: unconfirmed noise with the default filter. Failures just hide it.
    let abort = new AbortController();
    const count = () => { abort.abort(); abort = new AbortController(); const mine = abort; triageApi.preview({}, mine.signal).then(p => { if (!mine.signal.aborted) setCleanupCount(p.total); }).catch(() => { if (!mine.signal.aborted) setCleanupCount(null); }); };
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<DataChangedDetail | undefined>).detail;
      if (detail?.scopes.some(s => s === "meetings" || s === "intel")) count();
    };
    count();
    window.addEventListener(DATA_CHANGED_EVENT, onChanged);
    return () => { abort.abort(); window.removeEventListener(DATA_CHANGED_EVENT, onChanged); };
  }, []);
  useWorkspaceReturn(route);
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
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<DataChangedDetail | undefined>).detail;
      if (detail?.scopes.includes("portfolio")) { lastLoad.current = 0; void load(false, true); }
    };
    window.addEventListener(DATA_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(DATA_CHANGED_EVENT, onChanged);
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

  return <WorkspaceShell destination={tab} cleanupCount={cleanupCount} actions={<Group gap="md" justify="flex-end" className="workspace-toolbar">
    <Text size="sm" c="dimmed">Updated {relative(portfolio?.generatedAt ?? null)}</Text>
    <Group gap="xs"><Button variant="subtle" color="dark" disabled={!!busyId} leftSection={<IconRefresh size={14} aria-hidden="true" />} loading={busy} onClick={() => void load(true)}>Refresh</Button><Button variant="subtle" color="dark" leftSection={paused ? <IconPlay size={14} aria-hidden="true" /> : <IconPause size={14} aria-hidden="true" />} aria-pressed={paused} onClick={() => setPaused(v => !v)}>{paused ? "Resume auto-updates" : "Pause auto-updates"}</Button></Group>
  </Group>}>
        <Stack gap="md">
          {(error || portfolio?.stale) && <Alert color="red" icon={<IconStale size={18} aria-hidden="true" />} title="Showing saved information" role="alert"><Group gap="xs" align="center">{error ?? portfolio?.refreshError}<Button variant="default" size="xs" leftSection={<IconRefresh size={14} aria-hidden="true" />} onClick={() => void load(true)}>Retry</Button></Group></Alert>}
          {pending && <Alert color="blue" icon={<IconUpdate size={18} aria-hidden="true" />} title="Updated information is ready" role="status"><Group gap="xs" align="center">Your focused item has stayed in place.<Button size="xs" onClick={() => { if (!document.querySelector("[data-summary-editing]")) { setPortfolio(pending); setPending(null); } }}>Apply update</Button></Group></Alert>}
          {(navigation.invalidSelection || navigation.invalidRun) && <Alert color="orange" icon={<IconInvalid size={18} aria-hidden="true" />} title="Invalid destination" role="alert">This link does not identify available work. Choose an item from the directory.</Alert>}
          {tab === "voice" && <Suspense fallback={<Text role="status">Loading DAVE…</Text>}><VoicePanel variant="page" /></Suspense>}
          {!portfolio && tab !== "focus" && tab !== "voice" && tab !== "cleanup" && <Text role="status">{busy ? "Loading your portfolio…" : "No snapshot loaded."}</Text>}
          {tab === "focus" && <Suspense fallback={<Text role="status">Loading focus…</Text>}><FocusRoute route={route} paused={paused} /></Suspense>}
          {tab === "cleanup" && <Suspense fallback={<Text role="status">Loading Clean up…</Text>}><CleanupView bucket={navigation.bucket} /></Suspense>}
          {tab === "connections" && <ConnectionsView />}
          {tab === "agents" && <Suspense fallback={<Text role="status">Loading agent desk…</Text>}><AgentPlatform paused={paused} /></Suspense>}
          {tab === "meetings" && <Suspense fallback={<Text role="status">Loading meetings…</Text>}><MeetingsView route={route} paused={paused} refreshedAt={portfolio?.generatedAt ?? null} /></Suspense>}
          {portfolio && <>
            {tab === "queue" && <>
              <TodayView route={route} paused={paused} portfolio={portfolio} busyId={busyId} onResolve={resolve} onSeen={seen} actions={(item) => {
                const p = [...portfolio.active, ...portfolio.other, ...portfolio.hidden].find((p) => p.id === item.projectId);
                return p ? <Group align="flex-start" gap="xs">
                  <Button component="a" href={routeLink("projects", { id: p.id, return: safeReturn(route) })} variant="default" rightSection={<IconOpen size={14} aria-hidden="true" />} id={`destination-${item.id}`} data-workspace-focus={`request-project:${item.id}`}>View project</Button>
                  {(item.kind === "meeting-promise" || item.kind === "client-idea") && <Button component="a" href={routeLink("meetings", { section: item.kind === "client-idea" ? "asks" : null })} variant="default" rightSection={<IconOpen size={14} aria-hidden="true" />}>Open in Meetings</Button>}
                  <CopyText text={p.canonicalPath} label="Copy path" /><CopyText text={handoff(p, item)} label="Copy handoff" />
                </Group> : <Text size="sm">Project context unavailable; retained evidence may be stale.</Text>;
              }} />
            </>}
            {projectNavigation.destination === "projects" && <div hidden={tab !== "projects"}><ProjectsView items={portfolio.inbox} projects={[...portfolio.active, ...portfolio.other, ...portfolio.hidden]} query={projectNavigation.q} selectedId={projectNavigation.id} waiting={projectNavigation.waiting} route={projectRoute}
              onSearch={(value) => { const next = new URLSearchParams(params); next.set("q", value); const hash = `#projects?${next}`; window.history.replaceState(window.history.state, "", hash); setRoute(hash); }}
              busyId={busyId} onOverride={overrideProject} onCorrect={correctSummary} /></div>}
            {tab === "issues" && <Issues issues={portfolio.issues} coverage={portfolio.coverage} />}
          </>}
        </Stack>
        <VoiceLayer page={tab === "voice"} />
  </WorkspaceShell>;
}
