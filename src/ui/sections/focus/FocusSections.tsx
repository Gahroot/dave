import { Button, Text, Title } from "@mantine/core";
import { Check, X } from "lucide-react";
import type { FocusState, Lane, Proposal } from "../../../intel/types.ts";
import { CountPill, StatusMark, StatusTile } from "../../components/Status.tsx";
import { OWNER_LABEL, SOURCE_NAME, agoLabel, dueState, groupDecisions, proposalOrigin, sourcesWithWarnings } from "../../focus-model.ts";
import { routeLink } from "../../navigation.ts";
import { MOVE_KIND, PROMISE_GROUP, PROPOSAL_KIND, SOURCE_HEALTH, type StatusSpec } from "../../status.ts";
import { PlanRow } from "./DeliveryPlan.tsx";
import { PanelHead } from "../../components/WorkspacePrimitives.tsx";
import { BasisMark, ProvenanceList } from "./parts.tsx";

export type DecisionAct = (p: Proposal, act: "accept" | "reject", lane?: Lane) => void;

/** Decisions only you can make, grouped by project so each name is read once. A new client ask is filed in one click. */
export function Decisions({ decisions, busy, now, onAct }: { decisions: Proposal[]; busy: string | null; now: number; onAct: DecisionAct }) {
  const groups = groupDecisions(decisions);
  return <section aria-labelledby="dec-h" className="app-panel">
    <PanelHead id="dec-h" title="Waiting on you" spec={decisions.length ? MOVE_KIND.decide : { ...MOVE_KIND.decide, tone: "gray" }} count={decisions.length} countTone="amber"
      note={decisions.length ? "Decisions DAVE never makes for you. Nothing here is applied until you choose." : undefined}
      actions={<a className="panel-link" href={routeLink("cleanup", { bucket: "meeting_decisions" })}>Clean up drafted decisions</a>} />
    {!decisions.length ? <Text c="dimmed" className="panel-empty">No decisions are waiting.</Text> : groups.map(g => {
      const headId = `dec-${g.projectId}`;
      return <div key={g.projectId} className="decision-group" role="group" aria-labelledby={headId}>
        <h3 className="decision-group-head" id={headId}><a href={routeLink("focus", { project: g.projectId })}>{g.projectName}</a><CountPill value={g.decisions.length} /></h3>
        <ul className="plan-list">{g.decisions.map(p => <DecisionRow key={p.id} p={p} busy={busy} now={now} onAct={onAct} />)}</ul>
      </div>;
    })}
  </section>;
}

function DecisionRow({ p, busy, now, onAct }: { p: Proposal; busy: string | null; now: number; onAct: DecisionAct }) {
  const spec = PROPOSAL_KIND[p.kind];
  const working = busy === `proposal:${p.id}`;
  const off = !!busy && !working;
  const primary = (label: string, name: string, onClick: () => void) =>
    <Button size="xs" leftSection={<Check size={14} aria-hidden="true" />} loading={working} disabled={off} onClick={onClick} aria-label={`${name}: ${p.summary}`}>{label}</Button>;
  const quiet = (label: string, name: string, onClick: () => void) =>
    <Button size="xs" variant="default" disabled={!!busy} onClick={onClick} aria-label={`${name}: ${p.summary}`}>{label}</Button>;
  const reject = <Button size="xs" variant="subtle" color="red" leftSection={<X size={14} aria-hidden="true" />} disabled={!!busy} onClick={() => onAct(p, "reject")} aria-label={`Reject: ${p.summary}`}>Reject</Button>;
  const actions = p.kind === "new_requirement"
    ? <><span className="visually-hidden">File it:</span>
        {primary("Finish line", "Put on the finish line", () => onAct(p, "accept", "finish_line"))}
        {quiet("Extra", "File as an extra", () => onAct(p, "accept", "extra"))}
        {quiet("Phase 2", "File for Phase 2", () => onAct(p, "accept", "phase2"))}{reject}</>
    : <>{primary("Accept", "Accept", () => onAct(p, "accept"))}{reject}</>;
  return <PlanRow tone={spec.tone === "amber" ? undefined : spec.tone} lead={<StatusTile spec={spec} />} title={p.summary}
    sub={<span className="plan-row-meta"><span className={`plan-kind tone-${spec.tone}`}>{spec.label}</span>
      {p.detail && <span>{p.detail}</span>}
      {p.material && <span className="quiet-tag">Never applied automatically</span>}
      <BasisMark basis={proposalOrigin(p)} /></span>}
    actions={actions}
    more={p.provenance.length ? <details className="quiet-details"><summary>Where this came from ({p.provenance.length})</summary><ProvenanceList items={p.provenance} now={now} /></details> : undefined} />;
}

const dueSpec = (dueDate: string | null, now: number): StatusSpec => {
  const kind = dueState(dueDate, now).kind;
  return kind === "overdue" ? PROMISE_GROUP.overdue : kind === "today" || kind === "soon" ? PROMISE_GROUP.due_soon : PROMISE_GROUP.open;
};

export function External({ state, now }: { state: FocusState; now: number }) {
  const { blockers, commitments } = state.external;
  const count = blockers.length + commitments.length;
  return <section aria-labelledby="ext-h" className="app-panel">
    <PanelHead id="ext-h" title="Waiting on others and upcoming commitments" spec={blockers.length ? MOVE_KIND.chase : { ...PROMISE_GROUP.open, tone: "gray" }} count={count}
      actions={<a className="panel-link" href={routeLink("cleanup", { bucket: "overdue_promises" })}>Clean up overdue promises</a>} />
    {!count ? <Text c="dimmed" className="panel-empty">No external blockers or commitments due soon.</Text> : <ul className="plan-list">
      {blockers.map((b, i) => <PlanRow key={`b${i}`} tone="red" lead={<StatusTile spec={MOVE_KIND.chase} />} title={b.text}
        sub={<span className="plan-row-meta"><span className="plan-kind tone-red">Waiting on {OWNER_LABEL[b.owner].toLowerCase()}</span><span>{b.projectName}</span></span>} />)}
      {commitments.map(c => {
        const spec = dueSpec(c.dueDate, now);
        return <PlanRow key={c.itemId} tone={spec.tone === "red" ? "red" : undefined} lead={<StatusTile spec={spec} />} title={c.title}
          sub={<span className="plan-row-meta"><span className={`plan-kind tone-${spec.tone}`}>{dueState(c.dueDate, now).label}</span><span>{c.projectName}</span><span>{OWNER_LABEL[c.owner]}</span></span>} />;
      })}
    </ul>}
  </section>;
}

export function Changes({ state, now }: { state: FocusState; now: number }) {
  return <section aria-labelledby="chg-h"><Title order={2} id="chg-h">Recent changes</Title>
    {!state.recentChanges.length ? <Text c="dimmed">Nothing has changed since DAVE started tracking.</Text> : <ul className="plain-list">{state.recentChanges.slice(0, 12).map(c => <li key={c.id} className="result-row"><span /><span className="result-row-title">{c.summary}</span><span className="result-row-detail">{agoLabel(c.at, now)}{c.sources.length ? ` · ${c.sources.join(", ")}` : ""}</span></li>)}</ul>}
  </section>;
}

export function Sources({ state, now }: { state: FocusState; now: number }) {
  const rows = sourcesWithWarnings(state.sources, now);
  return <section aria-labelledby="src-h"><Title order={2} id="src-h" size="h4">Sources</Title>
    <ul className="plain-list sources-strip">{rows.map(({ source, warning }) => <li key={source.source}><StatusMark spec={SOURCE_HEALTH[source.state]}>{SOURCE_NAME[source.source]}: {SOURCE_HEALTH[source.state].label}</StatusMark>
      <Text size="xs" c="dimmed">{source.state === "not_connected" ? "Not connected" : `Last sync ${agoLabel(source.lastSyncAt, now)}`}{warning ? `. ${warning}` : ""}</Text></li>)}</ul>
    <Text size="xs" c="dimmed">Last reconcile {agoLabel(state.lastReconciledAt, now)}. Information from older syncs is not current.</Text>
  </section>;
}
