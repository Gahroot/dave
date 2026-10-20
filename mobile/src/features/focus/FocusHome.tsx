/** Delivery Intelligence home: client projects most behind first, each with the one move that unblocks it. */
import { useCallback, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ArrowRight, Check, ChevronRight, RefreshCw, X } from "lucide-react-native";
import type { FocusState, Lane, ProjectFocusRow, Proposal } from "../../../../src/intel/types.ts";
import {
  OWNER_LABEL, SOURCE_NAME, agoLabel, behindBand, behindLine, dueState, freshnessText, groupDecisions, homeGroups, homePulse,
  isFirstRun, proposalOrigin, sortDecisions, sourcesWithWarnings, stepLabel,
} from "../../../../src/ui/focus-model.ts";
import { DELIVERY_STEP, LANE, MOVE_KIND, PROMISE_GROUP, PROPOSAL_KIND, SOURCE_HEALTH } from "../../../../src/ui/status.ts";
import { ApiError, describeError } from "../../lib/api";
import {
  Button, Caption, Disclosure, Divider, EmptyState, Inline, LoadingState, Muted, Panel, Screen, Small, Stack, Tag, Title, tick,
} from "../../ui/primitives";
import { CountPill, StatusMark, StatusTile, type StatusSpec } from "../../ui/status";
import { colors, rail, radius, space, text, tints, tones, touch } from "../../ui/theme";
import { useIntelApi } from "./api";
import { calm, dueSpec } from "./model";
import { BasisMark, DoneMeter, BehindBadge, ErrorLine, FeedbackLine, KindLine, NumberTile, PlanRow, ProvenanceList } from "./parts";
import { EditingProvider, useEditingRegistry, useIntelResource } from "./useIntelResource";

type DecisionAct = (p: Proposal, act: "accept" | "reject", lane?: Lane) => void;

export function FocusHome() {
  const intel = useIntelApi();
  const registry = useEditingRegistry();
  const load = useCallback((s: AbortSignal) => intel.focus(s), [intel]);
  const { data, setData, pending, applyPending, error, loading, refreshing, reload, pull } = useIntelResource(load, "focus", registry.any);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const lock = useRef(false);
  const now = Date.now();

  const run = async (id: string, work: () => Promise<FocusState>) => {
    if (lock.current) return;
    lock.current = true; setBusy(id); setActionError(null);
    try { setData(await work()); tick(); } catch (e) {
      setActionError(describeError(e, "Request failed. Retry."));
      if (e instanceof ApiError && e.status === 409) reload();
    } finally { lock.current = false; setBusy(null); }
  };
  const reconcile = () => void run("reconcile", () => intel.reconcile());
  const refresh = <Button title="Refresh from sources" icon={RefreshCw} compact loading={busy === "reconcile"} disabled={!!busy && busy !== "reconcile"} onPress={reconcile} />;

  return <EditingProvider registry={registry}><Screen refreshing={refreshing} onRefresh={pull}>
    <Stack gap={space.sm}>
      <Title>Focus: most behind first</Title>
      <Muted>Your client projects, the one furthest behind at the top, each with its next move. DAVE only suggests; it never starts anything or contacts anyone.</Muted>
      <View style={styles.start}>{refresh}</View>
    </Stack>
    {pending && <FeedbackLine message="Newer information is ready. Your open edit was left alone."><Button title="Apply update" variant="primary" compact onPress={applyPending} /></FeedbackLine>}
    {actionError && <ErrorLine message={actionError} label="Dismiss" onRetry={() => setActionError(null)} />}
    {loading && !data && <LoadingState label="Loading your projects…" />}
    {error && <ErrorLine message={data ? `Showing the last loaded information. ${error}` : error} onRetry={reload} />}
    {data && <>
      {isFirstRun(data)
        ? <Panel><EmptyState title="No projects read yet" message="DAVE has not read your projects yet. Refresh to let DAVE draft a finish line for each project from meetings, git history and delivery plans. Nothing is applied until you confirm it." action={refresh} /></Panel>
        : <><Pulse state={data} /><ProjectOrder rows={data.projects} now={now} /></>}
      <Decisions decisions={sortDecisions(data.decisions)} busy={busy} now={now}
        onAct={(p, act, lane) => void run(`proposal:${p.id}`, () => act === "accept" ? intel.accept(p.id, undefined, lane) : intel.reject(p.id))} />
      <External state={data} now={now} />
      <SourcesAndChanges state={data} now={now} />
    </>}
  </Screen></EditingProvider>;
}

/** Today at a glance: four real counts, each repeated in its panel below. Calm gray when zero. */
function Pulse({ state }: { state: FocusState }) {
  const p = homePulse(state);
  const tiles: { label: string; value: number; spec: StatusSpec }[] = [
    { label: "In delivery", value: p.inDelivery, spec: LANE.finish_line },
    { label: "Overdue", value: p.overdue, spec: p.overdue ? PROMISE_GROUP.overdue : calm(PROMISE_GROUP.overdue) },
    { label: "Decisions waiting on you", value: p.decisions, spec: p.decisions ? MOVE_KIND.decide : calm(MOVE_KIND.decide) },
    { label: "Waiting on a client", value: p.waitingOnClient, spec: p.waitingOnClient ? MOVE_KIND.chase : calm(MOVE_KIND.chase) },
  ];
  return <View style={styles.pulse} accessibilityLabel="Today at a glance">
    {tiles.map(t => <View key={t.label} style={styles.pulseTile} accessible accessibilityLabel={`${t.label}: ${t.value}`}>
      <StatusTile spec={t.spec} size={18} />
      <View style={styles.flex}><Text style={text.heading}>{t.value}</Text><Caption>{t.label}</Caption></View>
    </View>)}
  </View>;
}

const ORDER_HELP = "Each project gets a behind score from 0 to 100. Time used against work done counts 50%, how far it is from delivered counts 30%, and days since you last verified something or marked a step count 20%. A project with no target date is scored on the last two alone (60% and 40%). Money is never part of the order. 70 or more reads far behind (red), 40 to 69 behind (amber), under 40 on pace (blue).";

/** Ranked projects first; unconfirmed and delivered ones wait in collapsed groups. */
function ProjectOrder({ rows, now }: { rows: readonly ProjectFocusRow[]; now: number }) {
  const { ranked, setup, delivered } = homeGroups(rows);
  return <Panel title="In delivery" spec={LANE.finish_line} count={ranked.length} note="Most behind first, each with the one move that unblocks it." padded={false}>
    <View style={styles.inset}><Disclosure title="How the order is worked out"><Small>{ORDER_HELP}</Small></Disclosure></View>
    {ranked.length
      ? ranked.map((r, i) => <View key={r.projectId}><Divider /><ProjectRow row={r} now={now} lead={<NumberTile n={i + 1} tone={behindBand(r.delivery.behind?.score ?? 0).tone} />} /></View>)
      : <View style={styles.inset}><Muted>{setup.length ? "No project has a confirmed finish line yet. Open one below and confirm what done means; DAVE ranks it from then on." : "No projects in delivery."}</Muted></View>}
    {setup.length > 0 && <View style={styles.inset}><Disclosure spec={MOVE_KIND.confirm_finish_line} title="Needs a finish line" count={setup.length} defaultOpen={!ranked.length}>
      <Caption>Not ranked until you confirm what done means</Caption>
      {setup.map(r => <ProjectRow key={r.projectId} row={r} now={now} lead={<StatusTile spec={MOVE_KIND.confirm_finish_line} />} />)}
    </Disclosure></View>}
    {delivered.length > 0 && <View style={styles.inset}><Disclosure spec={DELIVERY_STEP.signed_off} title="Delivered" count={delivered.length}>
      {delivered.map(r => <ProjectRow key={r.projectId} row={r} now={now} lead={<StatusTile spec={DELIVERY_STEP.signed_off} />} />)}
    </Disclosure></View>}
  </Panel>;
}

/** One row per project: name and flags, the next move, then the step, the score's parts and freshness. */
function ProjectRow({ row: r, lead, now }: { row: ProjectFocusRow; lead: ReactNode; now: number }) {
  const router = useRouter();
  const p = r.delivery;
  const score = p.confirmed && !p.delivered ? p.behind?.score ?? null : null;
  const band = score === null ? null : behindBand(score);
  return <Pressable onPress={() => router.push(`/focus/${r.projectId}`)} accessibilityRole="button"
    accessibilityLabel={`${r.projectName}${band ? `, behind score ${score}, ${band.label}` : ""}. Next: ${r.nextMove ?? "nothing is waiting on you"}`}
    style={({ pressed }) => [styles.projectRow, band && band.tone !== "blue" && { borderLeftWidth: rail, borderLeftColor: tones[band.tone], paddingLeft: space.lg - rail }, pressed && styles.pressed]}>
    {lead}
    <View style={styles.flex}><Stack gap={space.xs}>
      <Text style={[text.body, styles.bold]}>{r.projectName}</Text>
      {(p.waitingOnClient || p.overdue || r.priority !== null) && <Inline>
        {p.waitingOnClient && <StatusMark spec={MOVE_KIND.chase}>Waiting on client</StatusMark>}
        {p.overdue && <StatusMark spec={PROMISE_GROUP.overdue} strong>Overdue</StatusMark>}
        {r.priority !== null && <Tag>{`Priority ${r.priority}`}</Tag>}
      </Inline>}
      {r.nextMove
        ? <View style={styles.move}><ArrowRight size={14} color={colors.ink} /><Text style={[text.small, styles.flex, styles.bold]}>{r.nextMove}</Text></View>
        : <Muted>Nothing is waiting on you</Muted>}
      {p.confirmed && <Caption>{stepLabel(p)}</Caption>}
      {!p.delivered && <Caption>{behindLine(p)}</Caption>}
      {r.paidWhen && <Caption>{`Paid when ${r.paidWhen}`}</Caption>}
      <Caption>{freshnessText(r.freshness, r.lastReconciledAt, now)}</Caption>
      {p.confirmed && <DoneMeter progress={p} />}
    </Stack></View>
    {score !== null && <BehindBadge score={score} />}
    <ChevronRight size={18} color={colors.control} />
  </Pressable>;
}

/** Decisions only you can make, grouped by project. A new client ask is filed in one tap. */
function Decisions({ decisions, busy, now, onAct }: { decisions: Proposal[]; busy: string | null; now: number; onAct: DecisionAct }) {
  const router = useRouter();
  const groups = groupDecisions(decisions);
  return <Panel title="Waiting on you" spec={decisions.length ? MOVE_KIND.decide : calm(MOVE_KIND.decide)} count={decisions.length}
    note={decisions.length ? "Decisions DAVE never makes for you. Nothing here is applied until you choose." : undefined}
    actions={<Button title="Clean up drafted decisions" variant="subtle" compact onPress={() => router.push("/cleanup?bucket=meeting_decisions")} />}>
    {!decisions.length ? <Muted>No decisions are waiting.</Muted> : groups.map(g => <View key={g.projectId} style={styles.group}>
      <Inline>
        <Button title={g.projectName} variant="subtle" compact onPress={() => router.push(`/focus/${g.projectId}`)} accessibilityLabel={`Open ${g.projectName}`} />
        <CountPill value={g.decisions.length} />
      </Inline>
      {g.decisions.map(p => <DecisionRow key={p.id} p={p} busy={busy} now={now} onAct={onAct} />)}
    </View>)}
  </Panel>;
}

function DecisionRow({ p, busy, now, onAct }: { p: Proposal; busy: string | null; now: number; onAct: DecisionAct }) {
  const spec = PROPOSAL_KIND[p.kind];
  const working = busy === `proposal:${p.id}`;
  const off = !!busy && !working;
  const primary = (label: string, name: string, act: () => void) =>
    <Button key={name} title={label} icon={Check} variant="primary" compact loading={working} disabled={off} onPress={act} accessibilityLabel={`${name}: ${p.summary}`} />;
  const quiet = (label: string, name: string, act: () => void) =>
    <Button key={name} title={label} compact disabled={!!busy} onPress={act} accessibilityLabel={`${name}: ${p.summary}`} />;
  const reject = <Button key="reject" title="Reject" icon={X} variant="danger-subtle" compact disabled={!!busy} onPress={() => onAct(p, "reject")} accessibilityLabel={`Reject: ${p.summary}`} />;
  const actions = p.kind === "new_requirement"
    ? [primary("Finish line", "Put on the finish line", () => onAct(p, "accept", "finish_line")),
      quiet("Extra", "File as an extra", () => onAct(p, "accept", "extra")),
      quiet("Phase 2", "File for Phase 2", () => onAct(p, "accept", "phase2")), reject]
    : [primary("Accept", "Accept", () => onAct(p, "accept")), reject];
  return <PlanRow tone={spec.tone === "amber" ? undefined : spec.tone} lead={<StatusTile spec={spec} />} title={p.summary}
    sub={<Stack gap={space.xs}>
      <KindLine spec={spec}>{p.detail ?? undefined}</KindLine>
      <Inline>{p.material && <Tag>Never applied automatically</Tag>}<BasisMark basis={proposalOrigin(p)} /></Inline>
    </Stack>}
    actions={<>{p.kind === "new_requirement" && <Caption>File it:</Caption>}{actions}</>}
    more={p.provenance.length ? <Disclosure title={`Where this came from (${p.provenance.length})`}><ProvenanceList items={p.provenance} now={now} /></Disclosure> : undefined} />;
}

function External({ state, now }: { state: FocusState; now: number }) {
  const router = useRouter();
  const { blockers, commitments } = state.external;
  const count = blockers.length + commitments.length;
  return <Panel title="Waiting on others and upcoming commitments" spec={blockers.length ? MOVE_KIND.chase : calm(PROMISE_GROUP.open)} count={count}
    actions={<Button title="Clean up overdue promises" variant="subtle" compact onPress={() => router.push("/cleanup?bucket=overdue_promises")} />}>
    {!count ? <Muted>No external blockers or commitments due soon.</Muted> : <>
      {blockers.map((b, i) => <PlanRow key={`b${i}`} tone="red" lead={<StatusTile spec={MOVE_KIND.chase} />} title={b.text}
        sub={`Waiting on ${OWNER_LABEL[b.owner].toLowerCase()} · ${b.projectName}`} />)}
      {commitments.map(c => {
        const spec = dueSpec(c.dueDate, now);
        return <PlanRow key={c.itemId} tone={spec.tone === "red" ? "red" : undefined} lead={<StatusTile spec={spec} />} title={c.title}
          sub={`${dueState(c.dueDate, now).label} · ${c.projectName} · ${OWNER_LABEL[c.owner]}`} />;
      })}
    </>}
  </Panel>;
}

/** Sources and the change log are reference material: one disclosure, with source problems counted. */
function SourcesAndChanges({ state, now }: { state: FocusState; now: number }) {
  const rows = sourcesWithWarnings(state.sources, now);
  const warnings = rows.filter(s => s.warning !== null).length;
  return <Panel>
    <Disclosure title={`Sources and recent changes${warnings ? ` (${warnings} source ${warnings === 1 ? "needs" : "need"} attention)` : ""}`}>
      <Text style={text.subheading} accessibilityRole="header">Sources</Text>
      {rows.map(({ source, warning }) => <View key={source.source} style={styles.source}>
        <StatusMark spec={SOURCE_HEALTH[source.state]}>{SOURCE_NAME[source.source]}: {SOURCE_HEALTH[source.state].label}</StatusMark>
        <Caption>{source.state === "not_connected" ? "Not connected" : `Last sync ${agoLabel(source.lastSyncAt, now)}`}{warning ? `. ${warning}` : ""}</Caption>
      </View>)}
      <Caption>Last reconcile {agoLabel(state.lastReconciledAt, now)}. Information from older syncs is not current.</Caption>
      <Divider />
      <Text style={text.subheading} accessibilityRole="header">Recent changes</Text>
      {!state.recentChanges.length ? <Muted>Nothing has changed since DAVE started tracking.</Muted>
        : state.recentChanges.slice(0, 12).map(c => <View key={c.id} style={styles.source}>
          <Small selectable>{c.summary}</Small>
          <Caption>{agoLabel(c.at, now)}{c.sources.length ? ` · ${c.sources.join(", ")}` : ""}</Caption>
        </View>)}
    </Disclosure>
  </Panel>;
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  start: { alignSelf: "flex-start" },
  inset: { paddingHorizontal: space.lg },
  pulse: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  pulseTile: { flexBasis: "47%", flexGrow: 1, flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.md, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.panelBorder },
  projectRow: { flexDirection: "row", alignItems: "flex-start", gap: space.md, paddingVertical: space.md, paddingHorizontal: space.lg, minHeight: touch },
  pressed: { opacity: 0.7 },
  move: { flexDirection: "row", gap: space.xs, alignItems: "flex-start", backgroundColor: tints.amber, borderRadius: radius.sm, padding: space.xs },
  group: { gap: space.xs },
  source: { gap: space.xxs },
});
