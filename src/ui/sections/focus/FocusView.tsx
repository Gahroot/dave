import { useRef, useState } from "react";
import { Alert, Button, Group, List, Stack, Text, Title } from "@mantine/core";
import { ArrowRight, Check, RefreshCw, X } from "lucide-react";
import type { FocusState, Objective, Proposal } from "../../../intel/types.ts";
import { CopyText } from "../../components/CopyText.tsx";
import { CountPill, StatusMark } from "../../components/Status.tsx";
import { EmptyState, PageHeader } from "../../components/WorkspacePrimitives.tsx";
import {
  BRIEF_NOTICE, STAGE_LABEL, agoLabel, briefMode, countLine, dueState, freshnessText, isFirstRun, proposalOrigin, readinessSummary,
  sortDecisions, sortProjectRows, sourcesWithWarnings, SOURCE_NAME, OWNER_LABEL,
} from "../../focus-model.ts";
import { intelApi } from "../../intel-api.ts";
import { parseRoute, routeLink } from "../../navigation.ts";
import { ProjectIntelView } from "./ProjectIntelView.tsx";
import { OBJECTIVE_CATEGORY, PROPOSAL_KIND, SOURCE_HEALTH } from "../../status.ts";
import { BasisMark, BlockerList, ErrorLine, FreshnessMark, ProvenanceList, ReadinessStrip } from "./parts.tsx";
import { Changes, Decisions, External, Sources } from "./FocusSections.tsx";
import { useIntelResource } from "./useIntelResource.ts";

const errorText = (e: unknown) => e instanceof Error ? e.message : "Request failed. Retry.";

/** Delivery Intelligence home: one next action first, then everything that supports or challenges it. */
export function FocusView({ paused }: { paused: boolean }) {
  const { data, setData, pending, applyPending, error, loading, reload } = useIntelResource((s) => intelApi.focus(s), "focus", paused);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const lock = useRef(false);
  const now = Date.now();

  const run = async (id: string, work: () => Promise<FocusState>) => {
    if (lock.current) return;
    lock.current = true; setBusy(id); setActionError(null);
    try { setData(await work()); } catch (e) { setActionError(errorText(e)); } finally { lock.current = false; setBusy(null); }
  };
  const reconcile = () => void run("reconcile", () => intelApi.reconcile());

  const refresh = <Button variant="default" leftSection={<RefreshCw size={14} aria-hidden="true" />} loading={busy === "reconcile"} disabled={!!busy && busy !== "reconcile"} onClick={reconcile}>Refresh from sources</Button>;

  return <Stack gap="lg" className="focus-view">
    <PageHeader title="Focus" actions={refresh}>
      <Text c="dimmed" size="sm">The single most valuable next action across your projects, and why. DAVE decides what should happen next; it never starts anything.</Text>
    </PageHeader>
    {pending && <Alert color="blue" role="status" title="Newer information is ready"><Group gap="xs">Your open edit was left alone.<Button size="xs" onClick={applyPending}>Apply update</Button></Group></Alert>}
    {actionError && <ErrorLine message={actionError} onRetry={() => setActionError(null)} />}
    {loading && !data && <Text role="status">Loading your focus…</Text>}
    {error && <ErrorLine message={data ? `Showing the last loaded information. ${error}` : error} onRetry={reload} />}
    {data && <>
      {isFirstRun(data)
        ? <EmptyState title="No outcomes yet" action={refresh}>DAVE has not read your projects yet. Refresh to let DAVE draft a desired outcome for each project from meetings, git history and delivery plans. Nothing is applied until you confirm it.</EmptyState>
        : <TopAction objective={data.top} now={now} onRefresh={reconcile} />}
      <FocusQueue state={data} now={now} />
      <Decisions decisions={sortDecisions(data.decisions)} busy={busy} now={now}
        onAct={(p, act) => void run(`proposal:${p.id}`, () => act === "accept" ? intelApi.accept(p.id) : intelApi.reject(p.id))} />
      <External state={data} now={now} />
      <Changes state={data} now={now} />
      <Sources state={data} now={now} />
    </>}
  </Stack>;
}

function TopAction({ objective: o, now, onRefresh }: { objective: Objective | null; now: number; onRefresh: () => void }) {
  if (!o) return <section aria-labelledby="top-h"><Title order={2} id="top-h">Next action</Title><Text c="dimmed">Nothing is known to need doing. This can mean everything is done, or that DAVE has too little information; <Button variant="subtle" size="compact-sm" onClick={onRefresh}>refresh from sources</Button> to check.</Text></section>;
  const due = dueState(o.dueDate, now);
  const mode = briefMode(o);
  return <section aria-labelledby="top-h" className="focus-top next-action-row">
    <Stack gap="sm">
      <Group gap="md" className="row-sub"><span>{o.projectName}</span><span>{STAGE_LABEL[o.stage]}</span><StatusMark spec={OBJECTIVE_CATEGORY[o.category]} />{due.kind !== "none" && <span>{due.label}</span>}</Group>
      <Title order={2} id="top-h">Next action: {o.objective}</Title>
      {o.uncertain && <Alert color="violet" role="note" title="Uncertain">{o.uncertain}</Alert>}
      <div><Title order={3} size="h5">Why now</Title><Text>{o.whyNow}</Text></div>
      <div><Title order={3} size="h5">Definition of done</Title>
        {o.definitionOfDone.length ? <List listStyleType="none" spacing={4}>{o.definitionOfDone.map((d, i) => <List.Item key={i}><span className="done-box" aria-hidden="true" /> {d}</List.Item>)}</List> : <Text c="dimmed" size="sm">No definition of done recorded yet. Add one before starting.</Text>}</div>
      <div><Title order={3} size="h5">Blocked by</Title><BlockerList blockers={o.blockers} /></div>
      <div><Title order={3} size="h5">Evidence</Title><ProvenanceList items={o.evidence} now={now} /></div>
      <Group gap="md" align="flex-start" className="action-bar">
        {mode === "copy" && o.brief && <Stack gap={4}><CopyText text={o.brief} label="Copy EZcoder brief" /><Text size="xs" c="dimmed">{BRIEF_NOTICE}</Text></Stack>}
        {mode === "human" && <StatusMark spec={OBJECTIVE_CATEGORY[o.category]} strong>Human step: you do this yourself. No EZcoder brief.</StatusMark>}
        {mode === "none" && <Text size="sm" c="dimmed">No brief is available yet for this action.</Text>}
        <Button component="a" variant="subtle" href={routeLink("focus", { project: o.projectId })} rightSection={<ArrowRight size={14} aria-hidden="true" />}>Open {o.projectName}</Button>
      </Group>
    </Stack>
  </section>;
}

function FocusQueue({ state, now }: { state: FocusState; now: number }) {
  const rows = sortProjectRows(state.projects);
  return <section aria-labelledby="queue-h"><Group gap="xs"><Title order={2} id="queue-h">Focus queue</Title><CountPill value={rows.length} decorative={false} /></Group>
    {!rows.length ? <Text c="dimmed">No projects found yet.</Text> : <ul className="plain-list">{rows.map(r => <li key={r.projectId} className="workspace-row focus-row">
      <div className="row-main">
        <span />
        <div><a className="row-title" href={routeLink("focus", { project: r.projectId })}><strong>{r.projectName}</strong></a> <span className="quiet-tag">{STAGE_LABEL[r.stage]}</span>
          <Text size="sm">{r.objective ? r.objective.objective : r.outcome ? "No next action found." : "No outcome yet: DAVE will draft one on refresh."}</Text></div>
        <span className="row-aside"><FreshnessMark freshness={r.freshness} /></span>
        <div className="row-sub"><ReadinessStrip reached={r.readinessReached} compact /><span className="visually-hidden">{readinessSummary(r.readinessReached)}</span></div>
        <div className="row-sub"><span>{countLine(r.counts)}</span>{r.outcomeBasis && <BasisMark basis={r.outcomeBasis} />}{r.nextCommitment && <span>Next promise: {r.nextCommitment.title}, {dueState(r.nextCommitment.dueDate, now).label}</span>}<span>{freshnessText(r.freshness, r.lastReconciledAt, now)}</span></div>
      </div></li>)}</ul>}
  </section>;
}

/** Lazy entry: `#focus` is the home, `#focus?project=<id>` the drill-down. Invalid ids fall back to the home. */
export function FocusRoute({ route, paused }: { route: string; paused: boolean }) {
  const { project } = parseRoute(route);
  return project ? <ProjectIntelView projectId={project} paused={paused} /> : <FocusView paused={paused} />;
}
