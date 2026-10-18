import { useRef, useState, type ReactNode } from "react";
import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { ArrowRight, RefreshCw } from "lucide-react";
import type { FocusState, ProjectFocusRow } from "../../../intel/types.ts";
import { HelpTip, StatusGroup, StatusMark, StatusTile } from "../../components/Status.tsx";
import { EmptyState, PageHeader, PanelHead } from "../../components/WorkspacePrimitives.tsx";
import { behindBand, behindLine, freshnessText, homeGroups, homePulse, isFirstRun, sortDecisions, sourcesWithWarnings, stepLabel } from "../../focus-model.ts";
import { intelApi } from "../../intel-api.ts";
import { parseRoute, routeLink } from "../../navigation.ts";
import { DELIVERY_STEP, LANE, MOVE_KIND, PROMISE_GROUP, type StatusSpec } from "../../status.ts";
import { BehindDial, DoneMeter } from "./DeliveryPlan.tsx";
import { Changes, Decisions, External, Sources } from "./FocusSections.tsx";
import { ProjectIntelView } from "./ProjectIntelView.tsx";
import { ErrorLine } from "./parts.tsx";
import { useIntelResource } from "./useIntelResource.ts";
import { PreparedNextPanel, usePreparedNext } from "../../components/NextBestAction.tsx";
import { ProgressFeed } from "./ProgressFeed.tsx";
import { RecommendationReview } from "./RecommendationReview.tsx";

const errorText = (e: unknown) => e instanceof Error ? e.message : "Request failed. Retry.";

/** Delivery Intelligence home: client projects most behind first, each with the one move that unblocks it. */
export function FocusView({ paused }: { paused: boolean }) {
  const { data, setData, pending, applyPending, error, loading, reload } = useIntelResource((s) => intelApi.focus(s), "focus", paused);
  // DAVE's prepared next action; acting on it (record ops only) can change decisions or steps, so Focus reloads after.
  const prepared = usePreparedNext(paused, reload);
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
    <PageHeader title="Focus: most behind first" actions={refresh}>
      <Text c="dimmed" size="sm">Your client projects, the one furthest behind at the top, each with its next move. DAVE only suggests; it never starts anything or contacts anyone.</Text>
    </PageHeader>
    {pending && <Alert color="blue" role="status" title="Newer information is ready"><Group gap="xs">Your open edit was left alone.<Button size="xs" onClick={applyPending}>Apply update</Button></Group></Alert>}
    {actionError && <ErrorLine message={actionError} onRetry={() => setActionError(null)} />}
    {loading && !data && <Text role="status">Loading your projects…</Text>}
    {error && <ErrorLine message={data ? `Showing the last loaded information. ${error}` : error} onRetry={reload} />}
    {data && <>
      {!isFirstRun(data) && <PreparedNextPanel next={prepared} />}
      {isFirstRun(data)
        ? <div className="app-panel"><EmptyState title="No projects read yet" action={refresh}>DAVE has not read your projects yet. Refresh to let DAVE draft a finish line for each project from meetings, git history and delivery plans. Nothing is applied until you confirm it.</EmptyState></div>
        : <><Pulse state={data} /><ProgressFeed /><ProjectOrder rows={data.projects} now={now} /></>}
      <Decisions decisions={sortDecisions(data.decisions)} busy={busy} now={now}
        onAct={(p, act, lane) => void run(`proposal:${p.id}`, () => act === "accept" ? intelApi.accept(p.id, undefined, lane) : intelApi.reject(p.id))} />
      <External state={data} now={now} />
      <RecommendationReview />
      <SourcesAndChanges state={data} now={now} />
    </>}
  </Stack>;
}

const calm = (spec: StatusSpec): StatusSpec => ({ ...spec, tone: "gray" });

/** Today at a glance: four real counts, each repeated in its panel below. Calm gray when the count is zero. */
function Pulse({ state }: { state: FocusState }) {
  const p = homePulse(state);
  const tiles: { label: string; value: number; spec: StatusSpec }[] = [
    { label: "In delivery", value: p.inDelivery, spec: LANE.finish_line },
    { label: "Overdue", value: p.overdue, spec: p.overdue ? PROMISE_GROUP.overdue : calm(PROMISE_GROUP.overdue) },
    { label: "Decisions waiting on you", value: p.decisions, spec: p.decisions ? MOVE_KIND.decide : calm(MOVE_KIND.decide) },
    { label: "Waiting on a client", value: p.waitingOnClient, spec: p.waitingOnClient ? MOVE_KIND.chase : calm(MOVE_KIND.chase) },
  ];
  return <ul className="pulse-strip" aria-label="Today at a glance">
    {tiles.map(t => <li key={t.label} className="pulse-tile" data-tone={t.spec.tone}>
      <StatusTile spec={t.spec} size={18} />
      <span className="pulse-text"><strong className="pulse-n">{t.value}</strong><span className="pulse-label">{t.label}</span></span>
    </li>)}
  </ul>;
}

/** Ranked projects first; projects without a confirmed finish line and delivered ones wait in collapsed groups. */
function ProjectOrder({ rows, now }: { rows: readonly ProjectFocusRow[]; now: number }) {
  const { ranked, setup, delivered } = homeGroups(rows);
  return <section aria-labelledby="order-h" className="app-panel project-order">
    <PanelHead id="order-h" title="In delivery" spec={LANE.finish_line} count={ranked.length} note="Most behind first, each with the one move that unblocks it."
      help={<HelpTip label="How the order is worked out">
        <p>Each project gets a behind score from 0 to 100. Time used against work done counts 50%, how far it is from delivered counts 30%, and days since you last verified something or marked a step count 20%.</p>
        <p>A project with no target date is scored on the last two alone (60% and 40%). Money is never part of the order.</p>
        <p>70 or more reads far behind (red), 40 to 69 behind (amber), under 40 on pace (blue).</p>
      </HelpTip>} />
    {ranked.length
      ? <ol className="plain-list" aria-label="Projects in delivery, most behind first">{ranked.map((r, i) => <ProjectRow key={r.projectId} row={r} now={now}
          lead={<span className="rank-tile" data-tone={behindBand(r.delivery.behind?.score ?? 0).tone} aria-hidden="true">{i + 1}</span>} />)}</ol>
      : <Text c="dimmed" className="panel-empty">{setup.length ? "No project has a confirmed finish line yet. Open one below and confirm what done means; DAVE ranks it from then on." : "No projects in delivery."}</Text>}
    {setup.length > 0 && <StatusGroup spec={MOVE_KIND.confirm_finish_line} title="Needs a finish line" count={setup.length} open={!ranked.length} note="Not ranked until you confirm what done means">
      <ul className="plain-list">{setup.map(r => <ProjectRow key={r.projectId} row={r} now={now} lead={<StatusTile spec={MOVE_KIND.confirm_finish_line} />} />)}</ul>
    </StatusGroup>}
    {delivered.length > 0 && <StatusGroup spec={DELIVERY_STEP.signed_off} title="Delivered" count={delivered.length} open={false}>
      <ul className="plain-list">{delivered.map(r => <ProjectRow key={r.projectId} row={r} now={now} lead={<StatusTile spec={DELIVERY_STEP.signed_off} />} />)}</ul>
    </StatusGroup>}
  </section>;
}

/** One row per project: name and flags, the next move, then the step, the score's parts and freshness. */
function ProjectRow({ row: r, lead, now }: { row: ProjectFocusRow; lead: ReactNode; now: number }) {
  const p = r.delivery;
  const score = p.confirmed && !p.delivered ? p.behind?.score ?? null : null;
  const band = score === null ? null : behindBand(score);
  return <li className="project-order-row" data-tone={band && band.tone !== "blue" ? band.tone : undefined}>
    <span className="project-order-rank">{lead}</span>
    <span className="project-order-name">
      <a href={routeLink("focus", { project: r.projectId })}>{r.projectName}</a>
      {p.waitingOnClient && <StatusMark spec={MOVE_KIND.chase}>Waiting on client</StatusMark>}
      {p.overdue && <StatusMark spec={PROMISE_GROUP.overdue} strong>Overdue</StatusMark>}
      {r.priority !== null && <span className="quiet-tag direction-priority-tag">Priority {r.priority}</span>}
    </span>
    <span className={r.nextMove ? "project-order-move" : "project-order-move is-calm"}>{r.nextMove ? <><ArrowRight size={14} aria-hidden="true" /><span><span className="visually-hidden">Next: </span>{r.nextMove}</span></> : "Nothing is waiting on you"}</span>
    <span className="project-order-sub">
      {p.confirmed && <span>{stepLabel(p)}</span>}
      {!p.delivered && <span>{behindLine(p)}</span>}
      {r.paidWhen && <span className="direction-paid-when">Paid when {r.paidWhen}</span>}
      <span>{freshnessText(r.freshness, r.lastReconciledAt, now)}</span>
    </span>
    {p.confirmed && <span className="project-order-meter"><DoneMeter progress={p} /></span>}
    {score !== null && <span className="project-order-score"><BehindDial score={score} /></span>}
  </li>;
}

/** Sources and the change log are reference material: one disclosure, with source problems counted on the summary. */
function SourcesAndChanges({ state, now }: { state: FocusState; now: number }) {
  const warnings = sourcesWithWarnings(state.sources, now).filter(s => s.warning !== null).length;
  return <details className="quiet-details intel-disclosure">
    <summary>Sources and recent changes{warnings ? ` (${warnings} source ${warnings === 1 ? "needs" : "need"} attention)` : ""}</summary>
    <Stack gap="lg" pt="sm"><Sources state={state} now={now} /><Changes state={state} now={now} /></Stack>
  </details>;
}

/** Lazy entry: `#focus` is the home, `#focus?project=<id>` the drill-down. Invalid ids fall back to the home. */
export function FocusRoute({ route, paused }: { route: string; paused: boolean }) {
  const { project } = parseRoute(route);
  return project ? <ProjectIntelView projectId={project} paused={paused} /> : <FocusView paused={paused} />;
}
