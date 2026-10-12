import { Anchor, Button, Group, List, Text } from "@mantine/core";
import type { Basis, Blocker, EvidenceState, Freshness, Provenance, ReadinessLevel } from "../../../intel/types.ts";
import { StatusMark } from "../../components/Status.tsx";
import { BASIS, DELIVERY_FRESHNESS, EVIDENCE_STATE, READINESS_LEVEL } from "../../status.ts";
import { agoLabel, blockerOwnerText, evidenceFreshness, readinessCells, safeLink } from "../../focus-model.ts";

export function FreshnessMark({ freshness }: { freshness: Freshness }) {
  return <StatusMark spec={DELIVERY_FRESHNESS[freshness]} />;
}
export function BasisMark({ basis }: { basis: Basis }) { return <StatusMark spec={BASIS[basis]} />; }
export function EvidenceMark({ state }: { state: EvidenceState }) { return <StatusMark spec={EVIDENCE_STATE[state]} />; }

/** The four readiness levels, each on its own line so none reads as "done" for the others. */
export function ReadinessStrip({ reached, compact = false }: { reached: ReadinessLevel | null; compact?: boolean }) {
  return <ul className={`readiness-strip${compact ? " is-compact" : ""}`} aria-label="Readiness, four separate facts">
    {readinessCells(reached).map(c => <li key={c.level}>
      <StatusMark spec={c.reached ? READINESS_LEVEL[c.level] : { ...READINESS_LEVEL[c.level], tone: "gray", icon: EVIDENCE_STATE.not_implemented.icon }} size={14}>
        {READINESS_LEVEL[c.level].label}<span className="visually-hidden">{c.reached ? ": evidenced" : ": not evidenced"}</span>
      </StatusMark>
    </li>)}
  </ul>;
}

/** Source, quote, freshness, confidence, link. All text is escaped React text. */
export function ProvenanceList({ items, now }: { items: readonly Provenance[]; now: number }) {
  if (!items.length) return <Text size="sm" c="dimmed">No supporting evidence recorded. Treat this as unconfirmed.</Text>;
  return <List spacing={6} size="sm" listStyleType="none" className="provenance-list">
    {items.map((p, i) => {
      const link = safeLink(p.link);
      const fresh = evidenceFreshness(p.observedAt, now);
      return <List.Item key={`${p.sourceKind}-${p.sourceId ?? ""}-${i}`}>
        <div><strong>{link ? <Anchor href={link}>{p.label}</Anchor> : p.label}</strong> <span className="quiet-tag">{p.sourceKind.replace(/-/g, " ")}</span></div>
        {p.quote && <blockquote className="provenance-quote">{p.quote}</blockquote>}
        <Group gap="md" className="row-sub"><FreshnessMark freshness={fresh} /><span>Observed {agoLabel(p.observedAt, now)}</span><span>{p.confidence} confidence</span></Group>
      </List.Item>;
    })}
  </List>;
}

export function BlockerList({ blockers }: { blockers: readonly Blocker[] }) {
  if (!blockers.length) return <Text size="sm" c="dimmed">Nothing blocks this.</Text>;
  return <List size="sm" spacing={4}>{blockers.map((b, i) => <List.Item key={`${b.itemId ?? "b"}-${i}`}>{blockerOwnerText(b)}</List.Item>)}</List>;
}

export function ErrorLine({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <Group role="alert" gap="xs" className="feedback-line"><Text size="sm">{message}</Text><Button size="xs" variant="default" onClick={onRetry}>Retry</Button></Group>;
}
