/** The delivery workbench inside a project: finish line summary, your moves, tasks for EZcoder, extras. */
import { useEffect, useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { ArrowRight, Check, Undo2, X } from "lucide-react-native";
import type { Lane, Move, ProjectIntel, SuggestedTask } from "../../../../src/intel/types.ts";
import { BRIEF_NOTICE, behindLine, visibleMoves } from "../../../../src/ui/focus-model.ts";
import { LANE, MOVE_KIND, PROMISE_GROUP, TASK_STATE } from "../../../../src/ui/status.ts";
import { Button, Caption, Disclosure, Inline, Muted, Panel, Small, Stack, TextField } from "../../ui/primitives";
import { StatusMark, StatusTile } from "../../ui/status";
import { colors, radius, space, text } from "../../ui/theme";
import type { IntelApi } from "./api";
import { calm, dateError, draftOf, guessSpec, plural, railTone, targetLabel } from "./model";
import { BehindBadge, Checklist, CopyAndSend, DoneMeter, FeedbackLine, KindLine, NumberTile, OpenableSection, PlanRow, ProvenanceList, StepStrip } from "./parts";
import { useEditing } from "./useIntelResource";

/** Runs one mutation at a time and swaps in the returned project; false when it failed or another was running. */
export type Run = (key: string, work: () => Promise<ProjectIntel>) => Promise<boolean>;
/** A request to open one row's section: `move:<id>`, `item:<id>` or `finish-line`. `n` makes repeats re-fire. */
export type Reveal = { key: string; n: number };

type PlanProps = { data: ProjectIntel; busy: string | null; run: Run; reveal: (key: string) => void; intel: IntelApi };

const HOW_COUNTED = "Done counts only what you verified. The finish-line items share 70%. Going live, the client using it and their sign-off add 10% each.\n\nBehind mixes three parts: time used against work done (50%), how far from delivered (30%) and days since you last verified or marked a step (20%). With no target date, the last two count 60% and 40%.\n\n70 or more reads far behind (red), 40 to 69 behind (amber), under 40 on pace (blue).";

/** The finish line as the page's anchor: what done means, how far along it is, and how far behind. */
export function FinishLineSummary({ data, now }: { data: ProjectIntel; now: number }) {
  const p = data.plan.progress;
  const score = p.confirmed && !p.delivered ? p.behind?.score ?? null : null;
  return <Panel title="Finish line" spec={LANE.finish_line}>
    {(!p.confirmed || p.waitingOnClient || p.overdue) && <Inline>
      {!p.confirmed && <StatusMark spec={{ ...MOVE_KIND.confirm_finish_line, label: "Not confirmed" }} strong />}
      {p.waitingOnClient && <StatusMark spec={MOVE_KIND.chase}>Waiting on client</StatusMark>}
      {p.overdue && <StatusMark spec={PROMISE_GROUP.overdue} strong>Overdue</StatusMark>}
    </Inline>}
    <View style={styles.top}>
      <View style={styles.flex}>
        <Text style={[text.body, !data.outcome && { color: colors.muted }]} selectable>
          {data.outcome ? data.outcome.desiredOutcome : "Not written down yet. Until you confirm it, DAVE suggests no tasks."}
        </Text>
        <Caption>{targetLabel(p.targetDate, p.startDate, now)}</Caption>
      </View>
      {score !== null && <BehindBadge score={score} />}
    </View>
    <DoneMeter progress={p} />
    <StepStrip progress={p} />
    {p.behind && <Muted>Behind {p.behind.score}: {behindLine(p)}</Muted>}
    <Disclosure title="How done and behind are counted"><Small>{HOW_COUNTED}</Small></Disclosure>
  </Panel>;
}

export function Moves({ revealed, ...props }: PlanProps & { revealed: Reveal | null }) {
  const moves = props.data.plan.moves;
  const { shown, more } = visibleMoves(moves);
  const [moreOpen, setMoreOpen] = useState(false);
  const hidden = more.map(m => `move:${m.id}`).join("|");
  useEffect(() => { if (revealed && hidden.split("|").includes(revealed.key)) setMoreOpen(true); }, [revealed, hidden]);
  const row = (m: Move) => <MoveRow key={m.id} m={m} {...props} highlighted={revealed?.key === `move:${m.id}`} />;
  return <Panel title="Your moves" spec={moves.length ? MOVE_KIND.decide : calm(MOVE_KIND.decide)} count={moves.length}
    note={moves.length ? "Only you can do these. Each one unblocks the tasks below." : undefined}>
    {!moves.length ? <Muted>Nothing needs you right now.</Muted> : shown.map(row)}
    {more.length > 0 && <OpenableSection title={plural(more.length, "more move")} open={moreOpen} onToggle={setMoreOpen}>{more.map(row)}</OpenableSection>}
  </Panel>;
}

function MoveRow({ m, data, busy, run, reveal, intel, highlighted }: PlanProps & { m: Move; highlighted: boolean }) {
  const spec = MOVE_KIND[m.kind];
  const key = `move:${m.id}`;
  const working = busy === key;
  const off = !!busy && !working;
  const pid = data.projectId;
  const [goalOpen, setGoalOpen] = useState(false);
  const [date, setDate] = useState("");
  useEditing(!!date);
  const proposal = m.proposalId ? data.proposals.find(p => p.id === m.proposalId) ?? null : null;
  const go = (work: () => Promise<ProjectIntel>) => run(key, work);
  const decide = (accept: boolean, lane?: Lane) => {
    const id = m.proposalId;
    if (id) void go(async () => { await (accept ? intel.accept(id, undefined, lane) : intel.reject(id)); return intel.project(pid); });
  };
  const ok = (label: string, onPress: () => void) => <Button key={label} title={label} icon={Check} variant="primary" compact loading={working} disabled={off} onPress={onPress} />;
  const quiet = (label: string, onPress: () => void, icon?: typeof X) => <Button key={label} title={label} icon={icon} compact disabled={!!busy} onPress={onPress} />;
  const reject = <Button key="reject" title="Reject" icon={X} variant="danger-subtle" compact disabled={!!busy} onPress={() => decide(false)} accessibilityLabel={`Reject: ${m.title}`} />;

  let actions: ReactNode = null;
  let more: ReactNode = null;
  switch (m.kind) {
    case "confirm_finish_line": {
      const draft = draftOf(proposal);
      actions = <>{m.proposalId && draft && ok("Confirm DAVE's draft", () => decide(true))}{quiet(draft ? "Edit it first" : "Write it", () => reveal("finish-line"))}</>;
      if (draft) more = <View style={styles.quote}><Small selectable>{draft.text}</Small>{draft.criteria.length > 0 && <Checklist lines={draft.criteria} />}</View>;
      break;
    }
    case "decide":
      actions = m.proposalKind === "new_requirement"
        ? <><Caption>File it:</Caption>{ok("Finish line", () => decide(true, "finish_line"))}{quiet("Extra", () => decide(true, "extra"))}{quiet("Phase 2", () => decide(true, "phase2"))}{reject}</>
        : <>{ok("Accept", () => decide(true))}{reject}</>;
      if (proposal?.provenance.length) more = <Disclosure title={`Where this came from (${proposal.provenance.length})`}><ProvenanceList items={proposal.provenance} now={Date.now()} /></Disclosure>;
      break;
    case "chase":
      if (m.itemId) {
        const itemId = m.itemId;
        actions = <>{ok("They sent it", () => void go(() => intel.patchItem(itemId, { status: "done" })))}{quiet("Show it", () => reveal(`item:${itemId}`))}</>;
      }
      break;
    case "verify":
      if (m.itemId) {
        const itemId = m.itemId;
        actions = <>{ok("Verified", () => void go(() => intel.verifyItem(itemId)))}{quiet("Not right", () => void go(() => intel.reopenItem(itemId)), X)}</>;
        if (m.doneWhen.length) more = <Checklist lines={m.doneWhen} />;
      }
      break;
    case "rethink":
      if (m.itemId) {
        const itemId = m.itemId;
        const item = data.items.find(i => i.id === itemId);
        actions = <>{quiet(goalOpen ? "Close" : "Edit goal", () => setGoalOpen(o => !o))}<Button title="Move to Phase 2" compact loading={working} disabled={off} onPress={() => void go(() => intel.patchItem(itemId, { lane: "phase2" }))} /></>;
        if (goalOpen) more = <GoalForm itemId={itemId} goal={item?.goal ?? ""} busy={busy} run={run} intel={intel} onDone={() => setGoalOpen(false)} />;
      }
      break;
    case "step":
      if (m.step) { const step = m.step; actions = ok("Mark reached", () => void go(() => intel.setStep(pid, step, true))); }
      break;
    case "demo":
      actions = ok("Shown to the client", () => void go(() => intel.markDemo(pid)));
      break;
    case "target_date": {
      const set = (targetDate: string) => void go(() => intel.setSchedule(pid, { targetDate })).then(done => { if (done) setDate(""); });
      const suggested = m.suggestedDate;
      const invalid = dateError(date);
      actions = suggested ? ok(`Use ${suggested}`, () => set(suggested)) : null;
      more = <Stack gap={space.xs}>
        <TextField label={suggested ? "Or pick another date" : "Target date"} placeholder="YYYY-MM-DD" value={date} onChangeText={setDate}
          autoCapitalize="none" autoCorrect={false} keyboardType="numbers-and-punctuation" error={invalid} />
        <Button title="Set date" compact style={styles.start} disabled={!date || !!invalid || !!busy} onPress={() => set(date.trim())} />
      </Stack>;
      break;
    }
  }
  return <View style={highlighted ? styles.highlight : undefined}>
    <PlanRow tone={railTone(spec.tone)} lead={<StatusTile spec={spec} />} title={m.title} sub={<KindLine spec={spec}>{m.why}</KindLine>} actions={actions} more={more} />
  </View>;
}

/** Inline goal edit. Saving a new goal resets the "Not right" count on the server. */
function GoalForm({ itemId, goal, busy, run, intel, onDone }: { itemId: string; goal: string; busy: string | null; run: Run; intel: IntelApi; onDone: () => void }) {
  const key = `goal:${itemId}`;
  const [value, setValue] = useState(goal);
  useEditing(true);
  return <Stack gap={space.xs}>
    <TextField label="Goal" placeholder="So that the client can…" value={value} onChangeText={setValue} maxLength={300} />
    <Inline>
      <Button title="Save goal" variant="primary" compact loading={busy === key} disabled={!value.trim() || (!!busy && busy !== key)}
        onPress={() => void run(key, () => intel.patchItem(itemId, { goal: value.trim() })).then(ok => { if (ok) onDone(); })} />
      <Button title="Cancel" variant="subtle" compact onPress={onDone} />
    </Inline>
  </Stack>;
}

export function TaskList({ data, busy, run, reveal, intel }: PlanProps) {
  const { ready, waiting, sent, copyAll, progress } = data.plan;
  const pid = data.projectId;
  const [last, setLast] = useState<{ ids: string[]; label: string } | null>(null);
  const send = (key: string, ids: string[], label: string) =>
    void run(key, () => intel.markSent(pid, ids, true)).then(ok => { if (ok) setLast({ ids, label }); });
  const putBack = (key: string, ids: string[]) =>
    void run(key, () => intel.markSent(pid, ids, false)).then(ok => { if (ok) setLast(null); });
  const allIds = ready.map(t => t.itemId);

  return <Panel title="Suggested tasks for EZcoder" spec={TASK_STATE.sent} count={ready.length}
    note={progress.confirmed ? `In order. Copying a task marks it as sent. ${BRIEF_NOTICE}` : undefined}>
    {ready.length > 0 && <CopyAndSend text={copyAll} label={`Copy all ${plural(ready.length, "task")}`} variant="primary"
      loading={busy === "sent:all"} disabled={!!busy && busy !== "sent:all"}
      onCopied={() => send("sent:all", allIds, plural(allIds.length, "task"))} onMarkSent={() => send("sent:all", allIds, plural(allIds.length, "task"))} />}
    {last && <FeedbackLine tone="green" message={`Copied ${last.label} and marked ${last.ids.length === 1 ? "it" : "them"} as sent. Paste into EZcoder.`}>
      <Button title="Undo" icon={Undo2} compact loading={busy === "sent:undo"} disabled={!!busy && busy !== "sent:undo"} onPress={() => putBack("sent:undo", last.ids)} />
    </FeedbackLine>}
    {!progress.confirmed
      ? <Muted>No tasks until the finish line is confirmed.</Muted>
      : !ready.length
        ? <Muted>Nothing to send: everything is verified, sent or paused.</Muted>
        : ready.map((t, i) => <TaskRow key={t.itemId} t={t} n={i + 1} busy={busy} run={run} intel={intel} onSend={() => send(`sent:${t.itemId}`, [t.itemId], `task ${i + 1}`)} />)}
    {waiting.length > 0 && <Disclosure spec={TASK_STATE.waiting} title="Paused until you answer" count={waiting.length} defaultOpen>
      {waiting.map(t => <PlanRow key={t.itemId} lead={<StatusTile spec={TASK_STATE.waiting} />} title={t.build} sub={t.waitingOn ?? "Paused"}
        actions={t.waitingMoveId ? <Button title="Answer it" icon={ArrowRight} compact accessibilityLabel={`Answer what pauses: ${t.build}`}
          onPress={() => { if (t.waitingMoveId) reveal(`move:${t.waitingMoveId}`); }} /> : undefined} />)}
    </Disclosure>}
    {sent.length > 0 && <Disclosure spec={TASK_STATE.sent} title="Sent to EZcoder" count={sent.length}>
      {sent.map(t => <PlanRow key={t.itemId} lead={<StatusTile spec={TASK_STATE.sent} />} title={t.build} sub={t.orderReason}
        actions={t.sentAt ? <Button title="Put back" variant="subtle" compact loading={busy === `sent:${t.itemId}`} disabled={!!busy && busy !== `sent:${t.itemId}`}
          onPress={() => putBack(`sent:${t.itemId}`, [t.itemId])} accessibilityLabel={`Put back: ${t.build}`} /> : undefined} />)}
    </Disclosure>}
  </Panel>;
}

function TaskRow({ t, n, busy, run, intel, onSend }: { t: SuggestedTask; n: number; busy: string | null; run: Run; intel: IntelApi; onSend: () => void }) {
  const key = `sent:${t.itemId}`;
  const [goalOpen, setGoalOpen] = useState(false);
  return <PlanRow lead={<NumberTile n={n} />} title={t.build}
    sub={<Text style={text.muted} selectable>
      <Text style={t.goalDrafted ? styles.violet : undefined}>{t.goal}</Text>{t.goalDrafted ? <Text style={styles.violet}> · DAVE's draft</Text> : null} · {t.orderReason}
    </Text>}
    actions={<CopyAndSend text={t.text} label={`Copy task ${n}`} loading={busy === key} disabled={!!busy && busy !== key} onCopied={onSend} onMarkSent={onSend} />}
    more={<Disclosure title="Why, done when and the exact text">
      <Small selectable><Text style={styles.bold}>Why:</Text> {t.why}</Small>
      <Small strong>Done when{t.doneWhenDrafted ? " (DAVE's draft)" : ""}</Small>
      <Checklist lines={t.doneWhen} />
      <Inline>
        <Button title={goalOpen ? "Close" : "Edit goal"} compact disabled={!!busy} onPress={() => setGoalOpen(o => !o)} />
        <Button title="Not on the finish line" variant="subtle" compact disabled={!!busy} onPress={() => void run(`lane:${t.itemId}`, () => intel.patchItem(t.itemId, { lane: "extra" }))} />
      </Inline>
      {goalOpen && <GoalForm itemId={t.itemId} goal={t.goalDrafted ? "" : t.goal} busy={busy} run={run} intel={intel} onDone={() => setGoalOpen(false)} />}
      <View style={styles.quote} accessibilityLabel={`Task ${n}: exact text`}><Text style={text.mono} selectable>{t.text}</Text></View>
    </Disclosure>} />;
}

export function Extras({ data, busy, run, intel }: Omit<PlanProps, "reveal">) {
  const { extras, extrasCopy } = data.plan;
  if (!extras.length) return null;
  return <Panel>
    <Disclosure spec={LANE.extra} title="Bells & whistles" count={extras.length}>
      <Caption>Off the finish line; never suggested as tasks</Caption>
      <CopyAndSend text={extrasCopy} label="Copy list for the client" />
      {extras.map(t => {
        const key = `lane:${t.itemId}`;
        const other: Lane = t.lane === "phase2" ? "extra" : "phase2";
        const spec = t.laneGuessed ? guessSpec(t.lane) : LANE[t.lane];
        return <PlanRow key={t.itemId} tone={t.laneGuessed ? "violet" : undefined} lead={<StatusTile spec={spec} />} title={t.build}
          sub={<KindLine spec={spec}>{t.goal}</KindLine>}
          actions={<>
            <Button title="Move to finish line" compact loading={busy === key} disabled={!!busy && busy !== key} onPress={() => void run(key, () => intel.patchItem(t.itemId, { lane: "finish_line" }))} />
            <Button title={other === "phase2" ? "Phase 2" : "Extras"} variant="subtle" compact disabled={!!busy} onPress={() => void run(key, () => intel.patchItem(t.itemId, { lane: other }))} />
          </>} />;
      })}
    </Disclosure>
  </Panel>;
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0, gap: space.xs },
  top: { flexDirection: "row", gap: space.md, alignItems: "flex-start" },
  bold: { fontWeight: "600" },
  start: { alignSelf: "flex-start" },
  violet: { fontStyle: "italic" },
  quote: { backgroundColor: colors.sunken, borderRadius: radius.sm, padding: space.sm, gap: space.xs },
  highlight: { backgroundColor: colors.selected, borderRadius: radius.sm },
});
