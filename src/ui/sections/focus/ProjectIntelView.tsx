import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Group, NativeSelect, Stack, Text, TextInput, Textarea, Title } from "@mantine/core";
import { Lock, LockOpen, Check } from "lucide-react";
import type { DeliveryStage, IntelItem, ItemKind, ItemStatus, EvidenceState, ProjectIntel } from "../../../intel/types.ts";
import { DELIVERY_STAGES, READINESS_LEVELS } from "../../../intel/types.ts";
import { DetailHeader } from "../../components/WorkspacePrimitives.tsx";
import { StatusMark } from "../../components/Status.tsx";
import {
  ITEM_KIND_LABEL, ITEM_STATUS_LABEL, OWNER_LABEL, STAGE_LABEL, agoLabel, dueState, freshnessText, groupItemsByKind,
  meetingCommitments, openBlockers, parseLines,
} from "../../focus-model.ts";
import { intelApi, type ItemPatch, type OutcomeInput } from "../../intel-api.ts";
import { routeLink } from "../../navigation.ts";
import { EVIDENCE_STATE, LANE, OBJECTIVE_CATEGORY, READINESS_LEVEL } from "../../status.ts";
import { AgreementImport } from "./AgreementImport.tsx";
import { Extras, FinishLineSummary, Moves, TaskList, revealId, type Reveal, type Run } from "./DeliveryPlan.tsx";
import { BasisMark, ErrorLine, EvidenceMark, FreshnessMark, ProvenanceList, ReadinessStrip } from "./parts.tsx";
import { useIntelResource } from "./useIntelResource.ts";

const errorText = (e: unknown) => e instanceof Error ? e.message : "Request failed. Retry.";
const KINDS: ItemKind[] = ["requirement", "milestone", "commitment", "blocker", "decision", "exclusion"];
const STATUSES = Object.keys(ITEM_STATUS_LABEL) as ItemStatus[];
const EVIDENCE = Object.keys(EVIDENCE_STATE) as EvidenceState[];

/**
 * Project drill-down, in the order you act on it: the finish line, your moves, the tasks to copy, the extras,
 * then the editor and every item with its evidence behind disclosures.
 */
export function ProjectIntelView({ projectId, paused }: { projectId: string; paused: boolean }) {
  const { data, setData, pending, applyPending, error, loading, reload } = useIntelResource((s) => intelApi.project(projectId, s), `project:${projectId}`, paused);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Reveal | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [itemsOpen, setItemsOpen] = useState(false);
  const lock = useRef(false);
  const now = Date.now();

  const run: Run = async (id, work) => {
    if (lock.current) return false;
    lock.current = true; setBusy(id); setActionError(null);
    try { setData(await work()); return true; } catch (e) { setActionError(errorText(e)); return false; } finally { lock.current = false; setBusy(null); }
  };
  const reveal = useCallback((key: string) => setRevealed(r => ({ key, n: (r?.n ?? 0) + 1 })), []);
  useEffect(() => {
    if (!revealed) return;
    if (revealed.key === "finish-line") setEditorOpen(true);
    if (revealed.key.startsWith("item:")) setItemsOpen(true);
    const frame = window.requestAnimationFrame(() => {
      const el = document.getElementById(revealId(revealed.key));
      if (!el) return;
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
      el.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [revealed]);
  const confirmed = !!data?.plan.progress.confirmed;

  return <Stack gap="lg" className="focus-view">
    <DetailHeader title={data?.projectName ?? "Project"} back={routeLink("focus")} backLabel="Focus">
      <Group gap="xs">
        <Button component="a" variant="default" href={routeLink("projects", { id: projectId })}>Open project workspace</Button>
        <Button variant="default" loading={busy === "reconcile"} disabled={!!busy && busy !== "reconcile"} onClick={() => void run("reconcile", async () => { await intelApi.reconcile(projectId); return intelApi.project(projectId); })}>Refresh this project</Button>
      </Group>
    </DetailHeader>
    {pending && <Group role="status" gap="xs" className="feedback-line"><Text size="sm">Newer information is ready. Your open edit was left alone.</Text><Button size="xs" onClick={applyPending}>Apply update</Button></Group>}
    {actionError && <ErrorLine message={actionError} onRetry={() => setActionError(null)} />}
    {loading && !data && <Text role="status">Loading project…</Text>}
    {error && <ErrorLine message={data ? `Showing the last loaded information. ${error}` : error} onRetry={reload} />}
    {data && <>
      <Group gap="md" className="row-sub"><FreshnessMark freshness={data.freshness} /><span>{freshnessText(data.freshness, data.lastReconciledAt, now)}</span></Group>
      <FinishLineSummary data={data} now={now} />
      <Moves data={data} busy={busy} run={run} reveal={reveal} revealed={revealed} />
      <TaskList data={data} busy={busy} run={run} reveal={reveal} />
      <Extras data={data} busy={busy} run={run} />
      <details className="app-panel panel-disclosure" open={!confirmed || editorOpen} onToggle={e => setEditorOpen(e.currentTarget.open)}>
        <summary>{confirmed ? "Edit the finish line" : "Write the finish line"}</summary>
        <Stack gap="lg" className="panel-disclosure-body">
          <FinishLineEditor key={`${data.outcome?.updatedAt ?? "none"}:${data.plan.progress.targetDate ?? ""}:${data.plan.progress.startDate ?? ""}`} data={data} busy={busy}
            onSave={(input) => run("outcome", () => intelApi.putOutcome(projectId, input))} />
          <AgreementImport projectId={projectId} confirmed={confirmed} busy={busy} run={run} />
        </Stack>
      </details>
      <details className="app-panel panel-disclosure" open={itemsOpen} onToggle={e => setItemsOpen(e.currentTarget.open)}>
        <summary>All items and evidence ({data.items.length})</summary>
        <Stack gap="lg" className="panel-disclosure-body">
          <Items data={data} busy={busy} now={now} onPatch={(id, patch) => run(`item:${id}`, () => intelApi.patchItem(id, patch))} />
          <AddItem busy={busy} onAdd={(input) => run("add", () => intelApi.addItem(projectId, input))} />
          <Gaps data={data} />
          <Commitments data={data} now={now} />
          <section aria-labelledby="ready-h"><Title order={2} id="ready-h">Readiness</Title>
            <Text size="sm" c="dimmed">Four separate facts. One does not imply the next.</Text>
            <ul className="plain-list">{READINESS_LEVELS.map(l => <li key={l} className="result-row"><span /><span className="result-row-title">{READINESS_LEVEL[l].label}</span>
              <span className="result-row-detail">{data.outcome ? <EvidenceMark state={data.outcome.readiness[l]} /> : <EvidenceMark state="unknown" />}</span></li>)}</ul>
            <ReadinessStrip reached={highest(data)} compact />
          </section>
          <History data={data} now={now} />
        </Stack>
      </details>
    </>}
  </Stack>;
}

function highest(data: ProjectIntel) {
  const reached = data.items.map(i => i.readinessReached).filter((x): x is NonNullable<typeof x> => !!x);
  return reached.length ? [...reached].sort((a, b) => READINESS_LEVELS.indexOf(b) - READINESS_LEVELS.indexOf(a))[0] ?? null : null;
}

/** DAVE's pending draft, used to prefill the editor so confirming is an edit, not a blank page. */
function pendingDraft(data: ProjectIntel): { text: string; criteria: string[] } | null {
  const p = data.proposals.find(x => x.kind === "outcome_draft" && x.status === "pending");
  if (!p || typeof p.patch.desiredOutcome !== "string") return null;
  const raw = p.patch.acceptanceCriteria;
  return { text: p.patch.desiredOutcome, criteria: Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [] };
}

function FinishLineEditor({ data, busy, onSave }: { data: ProjectIntel; busy: string | null; onSave: (i: OutcomeInput) => Promise<boolean> }) {
  const o = data.outcome;
  const p = data.plan.progress;
  const draft = o ? null : pendingDraft(data);
  const initial = { text: o?.desiredOutcome ?? draft?.text ?? "", criteria: (o?.acceptanceCriteria ?? draft?.criteria ?? []).join("\n"), stage: o?.stage ?? "discovery", target: p.targetDate ?? "", start: p.startDate ?? "" };
  const [text, setText] = useState(initial.text);
  const [criteria, setCriteria] = useState(initial.criteria);
  const [stage, setStage] = useState<DeliveryStage>(initial.stage);
  const [target, setTarget] = useState(initial.target);
  const [start, setStart] = useState(initial.start);
  const dirty = text !== initial.text || criteria !== initial.criteria || stage !== initial.stage || target !== initial.target || start !== initial.start;
  const save = (lock?: boolean) => void onSave({
    desiredOutcome: text.trim(), acceptanceCriteria: parseLines(criteria), stage, lock: lock ?? o?.locked,
    targetDate: target || null, startDate: start || null,
  });
  return <section id={revealId("finish-line")} tabIndex={-1} aria-labelledby="out-h" data-intel-editing={dirty || undefined}>
    <Group gap="md"><Title order={3} size="h5" id="out-h">Finish line</Title>{o && <BasisMark basis={o.basis} />}{o?.locked && <StatusMark spec={{ ...EVIDENCE_STATE.verified, tone: "gray", icon: Lock, label: "Locked: reconcile proposes, never applies" }} />}</Group>
    {draft && <Text size="sm" className="tone-violet">Prefilled with DAVE's draft. Edit it, then confirm.</Text>}
    <Stack gap="xs" maw={720}>
      <Textarea label="What does “works like the client imagined” mean?" value={text} onChange={e => setText(e.currentTarget.value)} autosize minRows={2} maxLength={1000} />
      <Textarea label="How the client will check it (one per line)" value={criteria} onChange={e => setCriteria(e.currentTarget.value)} autosize minRows={2} />
      <Group gap="sm" align="flex-end" wrap="wrap">
        <TextInput label="Target date (optional)" type="date" value={target} onChange={e => setTarget(e.currentTarget.value)} />
        <TextInput label="Start date (optional)" description={o ? undefined : "Defaults to the day you confirm"} type="date" value={start} onChange={e => setStart(e.currentTarget.value)} />
        <NativeSelect label="Stage" value={stage} onChange={e => setStage(e.currentTarget.value as DeliveryStage)} data={DELIVERY_STAGES.map(s => ({ value: s, label: STAGE_LABEL[s] }))} />
      </Group>
      <Group gap="xs" className="action-bar">
        <Button leftSection={<Check size={14} aria-hidden="true" />} disabled={!text.trim() || (!!o && !dirty) || !!busy} loading={busy === "outcome"} onClick={() => save()}>{o ? "Save the finish line" : "Confirm the finish line"}</Button>
        {o && <Button variant="default" leftSection={o.locked ? <LockOpen size={14} aria-hidden="true" /> : <Lock size={14} aria-hidden="true" />} disabled={!!busy || dirty} onClick={() => save(!o.locked)}>{o.locked ? "Unlock" : "Lock"}</Button>}
      </Group>
    </Stack>
    {o && <ProvenanceList items={o.provenance} now={Date.now()} />}
  </section>;
}

function Items({ data, busy, now, onPatch }: { data: ProjectIntel; busy: string | null; now: number; onPatch: (id: string, p: ItemPatch) => Promise<boolean> }) {
  const groups = groupItemsByKind(data.items);
  return <section aria-labelledby="items-h"><Title order={2} id="items-h">Roadmap and requirements</Title>
    {!groups.length ? <Text c="dimmed">No items yet.</Text> : groups.map(g => <div key={g.kind}><Title order={3} size="h5">{ITEM_KIND_LABEL[g.kind]}s</Title>
      <ul className="plain-list">{g.items.map(item => <ItemRow key={`${item.id}:${item.updatedAt}`} item={item} busy={busy} now={now} onPatch={onPatch} />)}</ul></div>)}
  </section>;
}

function ItemRow({ item, busy, now, onPatch }: { item: IntelItem; busy: string | null; now: number; onPatch: (id: string, p: ItemPatch) => Promise<boolean> }) {
  const working = busy === `item:${item.id}`;
  const due = dueState(item.dueDate, now);
  const work = item.kind === "requirement" || item.kind === "milestone";
  return <li id={revealId(`item:${item.id}`)} tabIndex={-1} className="workspace-row focus-row"><Stack gap={4}>
    <Group gap="md" className="row-sub"><strong>{item.title}</strong><EvidenceMark state={item.evidenceState} /><BasisMark basis={item.basis} />
      {work && item.lane && <StatusMark spec={LANE[item.lane]} />}
      <span>{ITEM_STATUS_LABEL[item.status]}</span><span>{OWNER_LABEL[item.owner]}</span>{due.kind !== "none" && <span>{due.label}</span>}{item.locked && <span className="quiet-tag"><Lock size={12} aria-hidden="true" /> Locked</span>}
      <span>Supported {agoLabel(item.lastSupportedAt, now)}</span></Group>
    {item.detail && <Text size="sm">{item.detail}</Text>}
    {item.acceptance.length > 0 && <Text size="sm" c="dimmed">Acceptance: {item.acceptance.join("; ")}</Text>}
    <details><summary>Evidence and edit ({item.provenance.length})</summary>
      <ProvenanceList items={item.provenance} now={now} />
      <Group gap="xs" align="flex-end" className="action-bar">
        <NativeSelect label="Status" value={item.status} disabled={!!busy} onChange={e => void onPatch(item.id, { status: e.currentTarget.value as ItemStatus })} data={STATUSES.map(s => ({ value: s, label: ITEM_STATUS_LABEL[s] }))} />
        <NativeSelect label="Evidence" value={item.evidenceState} disabled={!!busy} onChange={e => void onPatch(item.id, { evidenceState: e.currentTarget.value as EvidenceState })} data={EVIDENCE.map(s => ({ value: s, label: EVIDENCE_STATE[s].label }))} />
        {item.basis === "inferred" && <Button size="xs" loading={working} disabled={!!busy && !working} leftSection={<Check size={14} aria-hidden="true" />} onClick={() => void onPatch(item.id, { confirm: true })}>Confirm</Button>}
        <Button size="xs" variant="default" disabled={!!busy} leftSection={item.locked ? <LockOpen size={14} aria-hidden="true" /> : <Lock size={14} aria-hidden="true" />} onClick={() => void onPatch(item.id, { locked: !item.locked })}>{item.locked ? "Unlock" : "Lock"}</Button>
      </Group>
    </details></Stack></li>;
}

function AddItem({ busy, onAdd }: { busy: string | null; onAdd: (i: { kind: ItemKind; title: string; detail?: string; dueDate?: string }) => Promise<boolean> }) {
  const [kind, setKind] = useState<ItemKind>("requirement");
  const [title, setTitle] = useState(""), [detail, setDetail] = useState(""), [due, setDue] = useState("");
  const dirty = !!(title || detail || due);
  return <section aria-labelledby="add-h" data-intel-editing={dirty || undefined}><Title order={2} id="add-h">Add an item</Title>
    <Stack gap="xs" maw={720}>
      <NativeSelect label="Kind" value={kind} onChange={e => setKind(e.currentTarget.value as ItemKind)} data={KINDS.map(k => ({ value: k, label: ITEM_KIND_LABEL[k] }))} />
      <TextInput label="Title" value={title} onChange={e => setTitle(e.currentTarget.value)} maxLength={300} />
      <Textarea label="Detail (optional)" value={detail} onChange={e => setDetail(e.currentTarget.value)} autosize minRows={2} />
      <TextInput label="Due date (optional)" type="date" value={due} onChange={e => setDue(e.currentTarget.value)} />
      <div><Button disabled={!title.trim() || !!busy} loading={busy === "add"} onClick={() => void onAdd({ kind, title: title.trim(), detail: detail.trim() || undefined, dueDate: due || undefined }).then(ok => { if (ok) { setTitle(""); setDetail(""); setDue(""); } })}>Add item</Button></div>
    </Stack></section>;
}

function Gaps({ data }: { data: ProjectIntel }) {
  const blockers = openBlockers(data.items);
  return <section aria-labelledby="gaps-h"><Title order={2} id="gaps-h">Gaps and blockers</Title>
    {!data.gaps.length && !blockers.length ? <Text c="dimmed">No gaps against the desired outcome are known. That is not proof there are none.</Text> : <ul className="plain-list">
      {data.gaps.map((g, i) => <li key={`g${i}`} className="result-row"><span /><span className="result-row-title">{g.text}</span><span className="result-row-detail"><EvidenceMark state={g.state} /> · {OBJECTIVE_CATEGORY[g.category].label}</span></li>)}
      {blockers.map(b => <li key={b.id} className="workspace-row focus-row" data-tone="red"><Text size="sm"><strong>Blocker ({OWNER_LABEL[b.owner]}):</strong> {b.title}</Text></li>)}
    </ul>}
  </section>;
}

function Commitments({ data, now }: { data: ProjectIntel; now: number }) {
  const items = meetingCommitments(data.items);
  return <section aria-labelledby="com-h"><Title order={2} id="com-h">Commitments from meetings</Title>
    {!items.length ? <Text c="dimmed">No open commitments from meetings.</Text> : <ul className="plain-list">{items.map(i => <li key={i.id} className="workspace-row focus-row"><Text size="sm"><strong>{i.title}</strong> <span className="quiet-tag">{dueState(i.dueDate, now).label}</span></Text><ProvenanceList items={i.provenance} now={now} /></li>)}</ul>}
  </section>;
}

function History({ data, now }: { data: ProjectIntel; now: number }) {
  return <section aria-labelledby="hist-h"><Title order={2} id="hist-h">Decisions and change history</Title>
    {data.proposals.length > 0 && <Text size="sm" c="dimmed">{data.proposals.filter(p => p.status === "pending").length} proposal(s) waiting; decide on <a href={routeLink("focus")}>Focus</a>.</Text>}
    {!data.history.length ? <Text c="dimmed">No history yet.</Text> : <ul className="plain-list">{data.history.map(h => <li key={h.id} className="result-row"><span /><span className="result-row-title">{h.summary}</span><span className="result-row-detail">{agoLabel(h.at, now)}{h.sources.length ? ` · ${h.sources.join(", ")}` : ""}</span></li>)}</ul>}
  </section>;
}
