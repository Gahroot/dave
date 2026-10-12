import { Button, Group, Stack, Text, Title } from "@mantine/core";
import { Check, X } from "lucide-react";
import type { FocusState, Proposal } from "../../../intel/types.ts";
import { CountPill, StatusMark } from "../../components/Status.tsx";
import { OWNER_LABEL, SOURCE_NAME, agoLabel, dueState, proposalOrigin, sourcesWithWarnings } from "../../focus-model.ts";
import { PROPOSAL_KIND, SOURCE_HEALTH } from "../../status.ts";
import { BasisMark, ProvenanceList } from "./parts.tsx";

export function Decisions({ decisions, busy, now, onAct }: { decisions: Proposal[]; busy: string | null; now: number; onAct: (p: Proposal, a: "accept" | "reject") => void }) {
  return <section aria-labelledby="dec-h"><Group gap="xs"><Title order={2} id="dec-h">Waiting on you</Title><CountPill value={decisions.length} tone="amber" decorative={false} /></Group>
    {!decisions.length ? <Text c="dimmed">No decisions are waiting.</Text> : <ul className="plain-list">{decisions.map(p => {
      const working = busy === `proposal:${p.id}`;
      return <li key={p.id} className="workspace-row focus-row" data-tone={PROPOSAL_KIND[p.kind].tone}>
        <Stack gap={6}>
          <Group gap="md" className="row-sub"><StatusMark spec={PROPOSAL_KIND[p.kind]} strong /><span>{p.projectName}</span>{p.material && <span className="quiet-tag">Material: never applied automatically</span>}<BasisMark basis={proposalOrigin(p)} /></Group>
          <Text fw={500}>{p.summary}</Text>{p.detail && <Text size="sm" c="dimmed">{p.detail}</Text>}
          <details><summary>Supporting evidence ({p.provenance.length})</summary><ProvenanceList items={p.provenance} now={now} /></details>
          <Group gap="xs" className="action-bar">
            <Button leftSection={<Check size={14} aria-hidden="true" />} loading={working} disabled={!!busy && !working} onClick={() => onAct(p, "accept")} aria-label={`Accept: ${p.summary}`}>Accept</Button>
            <Button variant="subtle" color="red" leftSection={<X size={14} aria-hidden="true" />} disabled={!!busy} onClick={() => onAct(p, "reject")} aria-label={`Reject: ${p.summary}`}>Reject</Button>
          </Group>
        </Stack></li>;
    })}</ul>}
  </section>;
}

export function External({ state, now }: { state: FocusState; now: number }) {
  const { blockers, commitments } = state.external;
  return <section aria-labelledby="ext-h"><Title order={2} id="ext-h">Waiting on others and upcoming commitments</Title>
    {!blockers.length && !commitments.length ? <Text c="dimmed">No external blockers or commitments due soon.</Text> : <ul className="plain-list">
      {blockers.map((b, i) => <li key={`b${i}`} className="workspace-row focus-row" data-tone="amber"><Text size="sm"><strong>{b.projectName}</strong>: waiting on {OWNER_LABEL[b.owner].toLowerCase()}. {b.text}</Text></li>)}
      {commitments.map(c => <li key={c.itemId} className="workspace-row focus-row"><Text size="sm"><strong>{c.projectName}</strong>: {c.title} <span className="quiet-tag">{OWNER_LABEL[c.owner]}</span> <span className="quiet-tag">{dueState(c.dueDate, now).label}</span></Text></li>)}
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
