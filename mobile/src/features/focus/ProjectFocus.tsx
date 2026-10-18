/**
 * Project focus, in the order you act on it: the finish line, your moves, the tasks to copy, the extras,
 * then the editor and every item with its evidence behind disclosures.
 */
import { useCallback, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Stack as RouterStack, useRouter } from "expo-router";
import { Check, ExternalLink, Lock, LockOpen, RefreshCw } from "lucide-react-native";
import type { DeliveryStage, EvidenceState, IntelItem, ItemKind, ItemStatus, ProjectIntel } from "../../../../src/intel/types.ts";
import { DELIVERY_STAGES, READINESS_LEVELS } from "../../../../src/intel/types.ts";
import {
  ITEM_KIND_LABEL, ITEM_STATUS_LABEL, OWNER_LABEL, STAGE_LABEL, agoLabel, dueState, freshnessText, groupItemsByKind,
  meetingCommitments, openBlockers, parseLines,
} from "../../../../src/ui/focus-model.ts";
import { EVIDENCE_STATE, LANE, OBJECTIVE_CATEGORY, READINESS_LEVEL } from "../../../../src/ui/status.ts";
import { ApiError, describeError } from "../../lib/api";
import {
  Button, Caption, Disclosure, Divider, Inline, LoadingState, Muted, Panel, Screen, SelectField, Small, Stack, Tag, TextField, tick,
} from "../../ui/primitives";
import { StatusMark } from "../../ui/status";
import { colors, radius, rail, space, text, tones } from "../../ui/theme";
import { AgreementImport } from "./AgreementImport";
import { DirectionPanel } from "./DirectionPanel";
import { useIntelApi, type ItemPatch, type NewItemInput, type OutcomeInput } from "./api";
import { Extras, FinishLineSummary, Moves, TaskList, type Reveal, type Run } from "./DeliveryPlan";
import { dateError, highestReadiness, pendingDraft } from "./model";
import { BasisMark, ErrorLine, EvidenceMark, FeedbackLine, FreshnessMark, OpenableSection, ProvenanceList, ReadinessStrip } from "./parts";
import { EditingProvider, useEditing, useEditingRegistry, useIntelResource } from "./useIntelResource";

const KINDS: ItemKind[] = ["requirement", "milestone", "commitment", "blocker", "decision", "exclusion"];
const STATUSES = Object.keys(ITEM_STATUS_LABEL) as ItemStatus[];
const EVIDENCE = Object.keys(EVIDENCE_STATE) as EvidenceState[];

export function ProjectFocus({ projectId }: { projectId: string }) {
  const intel = useIntelApi();
  const router = useRouter();
  const registry = useEditingRegistry();
  const load = useCallback((s: AbortSignal) => intel.project(projectId, s), [intel, projectId]);
  const { data, setData, pending, applyPending, error, loading, refreshing, reload, pull } = useIntelResource(load, `project:${projectId}`, registry.any);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Reveal | null>(null);
  const [editorOpenState, setEditorOpen] = useState<boolean | null>(null);
  const [itemsOpen, setItemsOpen] = useState(false);
  const lock = useRef(false);
  const now = Date.now();

  const run: Run = async (id, work) => {
    if (lock.current) return false;
    lock.current = true; setBusy(id); setActionError(null);
    try { setData(await work()); tick(); return true; } catch (e) {
      setActionError(describeError(e, "Request failed. Retry."));
      if (e instanceof ApiError && e.status === 409) reload();
      return false;
    } finally { lock.current = false; setBusy(null); }
  };
  const reveal = useCallback((key: string) => {
    setRevealed(r => ({ key, n: (r?.n ?? 0) + 1 }));
    if (key === "finish-line") setEditorOpen(true);
    if (key.startsWith("item:")) setItemsOpen(true);
  }, []);
  const confirmed = !!data?.plan.progress.confirmed;
  const editorOpen = editorOpenState ?? !confirmed;
  const revealNote = revealed?.key === "finish-line" ? "Opened the finish-line editor below." : revealed?.key.startsWith("item:") ? "Opened the item below, under All items and evidence." : null;

  return <EditingProvider registry={registry}><Screen refreshing={refreshing} onRefresh={pull}>
    <RouterStack.Screen options={{ title: data?.projectName ?? "Project focus" }} />
    <Inline>
      <Button title="Open project workspace" icon={ExternalLink} compact onPress={() => router.push(`/project/${projectId}`)} />
      <Button title="Refresh this project" icon={RefreshCw} compact loading={busy === "reconcile"} disabled={!!busy && busy !== "reconcile"}
        onPress={() => void run("reconcile", async () => { await intel.reconcile(projectId); return intel.project(projectId); })} />
    </Inline>
    {pending && <FeedbackLine message="Newer information is ready. Your open edit was left alone."><Button title="Apply update" variant="primary" compact onPress={applyPending} /></FeedbackLine>}
    {actionError && <ErrorLine message={actionError} label="Dismiss" onRetry={() => setActionError(null)} />}
    {loading && !data && <LoadingState label="Loading project…" />}
    {error && <ErrorLine message={data ? `Showing the last loaded information. ${error}` : error} onRetry={reload} />}
    {data && <>
      <Inline gap={space.md}><FreshnessMark freshness={data.freshness} /><Small>{freshnessText(data.freshness, data.lastReconciledAt, now)}</Small></Inline>
      <FinishLineSummary data={data} now={now} />
      <DirectionPanel data={data} busy={busy} run={run} now={now} intel={intel} />
      <Moves data={data} busy={busy} run={run} reveal={reveal} revealed={revealed} intel={intel} />
      <TaskList data={data} busy={busy} run={run} reveal={reveal} intel={intel} />
      <Extras data={data} busy={busy} run={run} intel={intel} />
      {revealNote && <FeedbackLine message={revealNote} />}
      <Panel>
        <OpenableSection title={confirmed ? "Edit the finish line" : "Write the finish line"} open={editorOpen} onToggle={setEditorOpen}>
          <FinishLineEditor key={`${data.outcome?.updatedAt ?? "none"}:${data.plan.progress.targetDate ?? ""}:${data.plan.progress.startDate ?? ""}`} data={data} busy={busy}
            onSave={(input) => run("outcome", () => intel.putOutcome(projectId, input))} />
          <Divider />
          <AgreementImport projectId={projectId} confirmed={confirmed} busy={busy} run={run} intel={intel} />
        </OpenableSection>
      </Panel>
      <Panel>
        <OpenableSection title={`All items and evidence (${data.items.length})`} open={itemsOpen} onToggle={setItemsOpen}>
          <Items data={data} busy={busy} now={now} revealedItem={revealed?.key.startsWith("item:") ? revealed.key.slice(5) : null}
            onPatch={(id, patch) => run(`item:${id}`, () => intel.patchItem(id, patch))} />
          <Divider />
          <AddItem busy={busy} onAdd={(input) => run("add", () => intel.addItem(projectId, input))} />
          <Divider />
          <Gaps data={data} />
          <Divider />
          <Commitments data={data} now={now} />
          <Divider />
          <Heading>Readiness</Heading>
          <Muted>Four separate facts. One does not imply the next.</Muted>
          {READINESS_LEVELS.map(l => <Inline key={l} gap={space.md}><Small strong>{READINESS_LEVEL[l].label}</Small>
            <EvidenceMark state={data.outcome ? data.outcome.readiness[l] : "unknown"} /></Inline>)}
          <ReadinessStrip reached={highestReadiness(data)} />
          <Divider />
          <History data={data} now={now} />
        </OpenableSection>
      </Panel>
    </>}
  </Screen></EditingProvider>;
}

function Heading({ children }: { children: string }) {
  return <Text style={text.subheading} accessibilityRole="header">{children}</Text>;
}

const LOCKED_SPEC = { ...EVIDENCE_STATE.verified, tone: "gray" as const, icon: Lock, label: "Locked: reconcile proposes, never applies" };

function FinishLineEditor({ data, busy, onSave }: { data: ProjectIntel; busy: string | null; onSave: (i: OutcomeInput) => Promise<boolean> }) {
  const o = data.outcome;
  const p = data.plan.progress;
  const draft = o ? null : pendingDraft(data);
  const initial = { text: o?.desiredOutcome ?? draft?.text ?? "", criteria: (o?.acceptanceCriteria ?? draft?.criteria ?? []).join("\n"), stage: o?.stage ?? "discovery", target: p.targetDate ?? "", start: p.startDate ?? "" };
  const [value, setValue] = useState(initial.text);
  const [criteria, setCriteria] = useState(initial.criteria);
  const [stage, setStage] = useState<DeliveryStage>(initial.stage);
  const [target, setTarget] = useState(initial.target);
  const [start, setStart] = useState(initial.start);
  const dirty = value !== initial.text || criteria !== initial.criteria || stage !== initial.stage || target !== initial.target || start !== initial.start;
  useEditing(dirty);
  const targetError = dateError(target);
  const startError = dateError(start);
  const save = (lockIt?: boolean) => void onSave({
    desiredOutcome: value.trim(), acceptanceCriteria: parseLines(criteria), stage, lock: lockIt ?? o?.locked,
    targetDate: target.trim() || null, startDate: start.trim() || null,
  });
  return <Stack gap={space.sm}>
    <Inline gap={space.md}><Heading>Finish line</Heading>{o && <BasisMark basis={o.basis} />}{o?.locked && <StatusMark spec={LOCKED_SPEC} />}</Inline>
    {draft && <StatusMark spec={{ ...LANE.finish_line, tone: "violet", label: "Prefilled with DAVE's draft. Edit it, then confirm." }} />}
    <TextField label="What does “works like the client imagined” mean?" value={value} onChangeText={setValue} multiline maxLength={1000} />
    <TextField label="How the client will check it (one per line)" value={criteria} onChangeText={setCriteria} multiline />
    <TextField label="Target date (optional)" placeholder="YYYY-MM-DD" value={target} onChangeText={setTarget} error={targetError}
      autoCapitalize="none" autoCorrect={false} keyboardType="numbers-and-punctuation" />
    <TextField label="Start date (optional)" placeholder="YYYY-MM-DD" value={start} onChangeText={setStart} error={startError}
      help={o ? undefined : "Defaults to the day you confirm"} autoCapitalize="none" autoCorrect={false} keyboardType="numbers-and-punctuation" />
    <SelectField label="Stage" value={stage} onChange={setStage} options={DELIVERY_STAGES.map(s => ({ value: s, label: STAGE_LABEL[s] }))} />
    <Inline>
      <Button title={o ? "Save the finish line" : "Confirm the finish line"} icon={Check} variant="primary"
        disabled={!value.trim() || (!!o && !dirty) || !!busy || !!targetError || !!startError} loading={busy === "outcome"} onPress={() => save()} />
      {o && <Button title={o.locked ? "Unlock" : "Lock"} icon={o.locked ? LockOpen : Lock} disabled={!!busy || dirty} onPress={() => save(!o.locked)} />}
    </Inline>
    {o && <ProvenanceList items={o.provenance} now={Date.now()} />}
  </Stack>;
}

function Items({ data, busy, now, revealedItem, onPatch }: { data: ProjectIntel; busy: string | null; now: number; revealedItem: string | null; onPatch: (id: string, p: ItemPatch) => Promise<boolean> }) {
  const groups = groupItemsByKind(data.items);
  return <Stack gap={space.sm}>
    <Heading>Roadmap and requirements</Heading>
    {!groups.length ? <Muted>No items yet.</Muted> : groups.map(g => <Stack key={g.kind} gap={space.xs}>
      <Small strong>{ITEM_KIND_LABEL[g.kind]}s</Small>
      {g.items.map(item => <ItemRow key={`${item.id}:${item.updatedAt}`} item={item} busy={busy} now={now} open={revealedItem === item.id} onPatch={onPatch} />)}
    </Stack>)}
  </Stack>;
}

function ItemRow({ item, busy, now, open, onPatch }: { item: IntelItem; busy: string | null; now: number; open: boolean; onPatch: (id: string, p: ItemPatch) => Promise<boolean> }) {
  const working = busy === `item:${item.id}`;
  const due = dueState(item.dueDate, now);
  const work = item.kind === "requirement" || item.kind === "milestone";
  return <View style={[styles.item, open && styles.itemRevealed]}>
    <Text style={[text.body, styles.bold]} selectable>{item.title}</Text>
    <Inline gap={space.md}>
      <EvidenceMark state={item.evidenceState} /><BasisMark basis={item.basis} />
      {work && item.lane && <StatusMark spec={LANE[item.lane]} />}
      <Small>{ITEM_STATUS_LABEL[item.status]}</Small><Small>{OWNER_LABEL[item.owner]}</Small>
      {due.kind !== "none" && <Small>{due.label}</Small>}
      {item.locked && <Tag>Locked</Tag>}
      <Caption>Supported {agoLabel(item.lastSupportedAt, now)}</Caption>
    </Inline>
    {item.detail && <Small selectable>{item.detail}</Small>}
    {item.acceptance.length > 0 && <Muted selectable>Acceptance: {item.acceptance.join("; ")}</Muted>}
    <Disclosure key={open ? "open" : "closed"} defaultOpen={open} title={`Evidence and edit (${item.provenance.length})`}>
      <ProvenanceList items={item.provenance} now={now} />
      <SelectField label="Status" value={item.status} disabled={!!busy} onChange={s => void onPatch(item.id, { status: s })}
        options={STATUSES.map(s => ({ value: s, label: ITEM_STATUS_LABEL[s] }))} />
      <SelectField label="Evidence" value={item.evidenceState} disabled={!!busy} onChange={s => void onPatch(item.id, { evidenceState: s })}
        options={EVIDENCE.map(s => ({ value: s, label: EVIDENCE_STATE[s].label }))} />
      <Inline>
        {item.basis === "inferred" && <Button title="Confirm" icon={Check} variant="primary" compact loading={working} disabled={!!busy && !working} onPress={() => void onPatch(item.id, { confirm: true })} />}
        <Button title={item.locked ? "Unlock" : "Lock"} icon={item.locked ? LockOpen : Lock} compact disabled={!!busy} onPress={() => void onPatch(item.id, { locked: !item.locked })} />
      </Inline>
    </Disclosure>
  </View>;
}

function AddItem({ busy, onAdd }: { busy: string | null; onAdd: (i: NewItemInput) => Promise<boolean> }) {
  const [kind, setKind] = useState<ItemKind>("requirement");
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [due, setDue] = useState("");
  useEditing(!!(title || detail || due));
  const dueError = dateError(due);
  return <Stack gap={space.sm}>
    <Heading>Add an item</Heading>
    <SelectField label="Kind" value={kind} onChange={setKind} options={KINDS.map(k => ({ value: k, label: ITEM_KIND_LABEL[k] }))} />
    <TextField label="Title" value={title} onChangeText={setTitle} maxLength={300} />
    <TextField label="Detail (optional)" value={detail} onChangeText={setDetail} multiline />
    <TextField label="Due date (optional)" placeholder="YYYY-MM-DD" value={due} onChangeText={setDue} error={dueError}
      autoCapitalize="none" autoCorrect={false} keyboardType="numbers-and-punctuation" />
    <Button title="Add item" style={styles.start} disabled={!title.trim() || !!busy || !!dueError} loading={busy === "add"}
      onPress={() => void onAdd({ kind, title: title.trim(), detail: detail.trim() || undefined, dueDate: due.trim() || undefined }).then(ok => { if (ok) { setTitle(""); setDetail(""); setDue(""); } })} />
  </Stack>;
}

function Gaps({ data }: { data: ProjectIntel }) {
  const blockers = openBlockers(data.items);
  return <Stack gap={space.sm}>
    <Heading>Gaps and blockers</Heading>
    {!data.gaps.length && !blockers.length ? <Muted>No gaps against the desired outcome are known. That is not proof there are none.</Muted> : <>
      {data.gaps.map((g, i) => <Stack key={`g${i}`} gap={space.xxs}><Small selectable>{g.text}</Small>
        <Inline><EvidenceMark state={g.state} /><Caption>{OBJECTIVE_CATEGORY[g.category].label}</Caption></Inline></Stack>)}
      {blockers.map(b => <View key={b.id} style={styles.blocker}><Small selectable><Text style={styles.bold}>Blocker ({OWNER_LABEL[b.owner]}):</Text> {b.title}</Small></View>)}
    </>}
  </Stack>;
}

function Commitments({ data, now }: { data: ProjectIntel; now: number }) {
  const items = meetingCommitments(data.items);
  return <Stack gap={space.sm}>
    <Heading>Commitments from meetings</Heading>
    {!items.length ? <Muted>No open commitments from meetings.</Muted> : items.map(i => <Stack key={i.id} gap={space.xs}>
      <Inline><Small strong selectable>{i.title}</Small><Tag>{dueState(i.dueDate, now).label}</Tag></Inline>
      <ProvenanceList items={i.provenance} now={now} />
    </Stack>)}
  </Stack>;
}

function History({ data, now }: { data: ProjectIntel; now: number }) {
  const router = useRouter();
  return <Stack gap={space.sm}>
    <Heading>Decisions and change history</Heading>
    {data.proposals.length > 0 && <Inline>
      <Muted>{data.proposals.filter(p => p.status === "pending").length} proposal(s) waiting; decide on Focus.</Muted>
      <Button title="Go to Focus" variant="subtle" compact onPress={() => router.navigate("/")} />
    </Inline>}
    {!data.history.length ? <Muted>No history yet.</Muted> : data.history.map(h => <Stack key={h.id} gap={space.xxs}>
      <Small selectable>{h.summary}</Small>
      <Caption>{agoLabel(h.at, now)}{h.sources.length ? ` · ${h.sources.join(", ")}` : ""}</Caption>
    </Stack>)}
  </Stack>;
}

const styles = StyleSheet.create({
  bold: { fontWeight: "600" },
  start: { alignSelf: "flex-start" },
  item: { gap: space.xs, paddingVertical: space.sm },
  itemRevealed: { backgroundColor: colors.selected, paddingHorizontal: space.sm, borderRadius: radius.sm },
  blocker: { borderLeftWidth: rail, borderLeftColor: tones.red, paddingLeft: space.sm },
});
