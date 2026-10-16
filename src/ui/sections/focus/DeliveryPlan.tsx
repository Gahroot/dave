import { useEffect, useState, type ReactNode } from "react";
import { Button, Group, List, Stack, Text, TextInput, Textarea, Title } from "@mantine/core";
import { ArrowRight, Check, CircleDashed, Copy, Undo2, X } from "lucide-react";
import type { DeliveryProgress, Lane, Move, ProjectIntel, Proposal, SuggestedTask } from "../../../intel/types.ts";
import { CopyText } from "../../components/CopyText.tsx";
import { HelpTip, StatusGroup, StatusIcon, StatusMark, StatusTile } from "../../components/Status.tsx";
import { BRIEF_NOTICE, STEP_GOAL, behindBand, behindLine, dueState, progressLine, stepCells, stepLabel, visibleMoves } from "../../focus-model.ts";
import { intelApi } from "../../intel-api.ts";
import { DELIVERY_STEP, LANE, MOVE_KIND, PROMISE_GROUP, TASK_STATE, type StatusSpec } from "../../status.ts";
import { PanelHead } from "../../components/WorkspacePrimitives.tsx";
import { ProvenanceList } from "./parts.tsx";

/**
 * The delivery workbench inside a project. Every list uses one row anatomy (lead mark, one bold line, one muted
 * line, actions on the right) so the page scans top to bottom; detail sits behind native disclosures.
 */

/** Runs one mutation at a time and swaps in the returned project; false when it failed or another was running. */
export type Run = (key: string, work: () => Promise<ProjectIntel>) => Promise<boolean>;
/** A request to scroll to and focus one row: `move:<id>`, `item:<id>` or `finish-line`. `n` makes repeats re-fire. */
export type Reveal = { key: string; n: number };

/** DOM id for a reveal key. Ids are hex or fixed words; anything else is replaced so the id stays valid. */
export const revealId = (key: string): string => `intel-${key.replace(/[^A-Za-z0-9_-]/g, "-")}`;

const guessSpec = (lane: Lane): StatusSpec => ({ ...LANE[lane], tone: "violet", label: `DAVE's guess: ${LANE[lane].label}` });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** Inside a panel that is all your moves, the tile already says amber; a rail is kept only for red and violet. */
const railTone = (tone: StatusSpec["tone"]): StatusSpec["tone"] | undefined => tone === "amber" ? undefined : tone;

/** One row anatomy for moves, tasks, extras and decisions. */
export function PlanRow({ id, tone, lead, title, sub, actions, more }: {
  id?: string; tone?: StatusSpec["tone"]; lead: ReactNode; title: ReactNode; sub?: ReactNode; actions?: ReactNode; more?: ReactNode;
}) {
  return <li id={id} tabIndex={id ? -1 : undefined} className="workspace-row plan-row" data-tone={tone}>
    <span className="plan-row-lead">{lead}</span>
    <span className="plan-row-title">{title}</span>
    {actions && <span className="plan-row-actions">{actions}</span>}
    {sub && <span className="plan-row-sub">{sub}</span>}
    {more && <div className="plan-row-more">{more}</div>}
  </li>;
}

function Checklist({ lines }: { lines: readonly string[] }) {
  return <List listStyleType="none" spacing={2} size="sm">{lines.map((d, i) => <List.Item key={i}><span className="done-box" aria-hidden="true" /> {d}</List.Item>)}</List>;
}

// ---- finish line summary ------------------------------------------------------------------------------------

/** Verified share as a bar. The words carry the meaning; the bar only repeats it. */
export function DoneMeter({ progress }: { progress: DeliveryProgress }) {
  return <div className="done-meter">
    <span className="done-meter-text">{progressLine(progress)}</span>
    <span className="done-meter-bar" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, progress.percentDone))}%` }} /></span>
  </div>;
}

/** The behind score as a ring. The number is the meaning; the ring and its band colour only repeat it. */
export function BehindDial({ score, size = 52 }: { score: number; size?: number }) {
  const band = behindBand(score);
  const mid = size / 2;
  const r = mid - 4;
  const circumference = 2 * Math.PI * r;
  const filled = (Math.max(0, Math.min(100, score)) / 100) * circumference;
  return <span className="behind-dial" data-tone={band.tone}>
    <span className="visually-hidden">Behind score {score} of 100, {band.label.toLowerCase()}</span>
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
      <circle cx={mid} cy={mid} r={r} className="behind-dial-track" />
      {filled > 0 && <circle cx={mid} cy={mid} r={r} className="behind-dial-arc" strokeDasharray={`${filled} ${circumference}`} transform={`rotate(-90 ${mid} ${mid})`} />}
    </svg>
    <strong className="behind-dial-n" aria-hidden="true">{score}</strong>
    <span className="behind-dial-label" aria-hidden="true">{band.label}</span>
  </span>;
}

/** Four separate marks: reaching a later step never claims an earlier one. */
export function StepStrip({ progress }: { progress: DeliveryProgress }) {
  return <ol className="milestone-strip step-tiles" aria-label={`Delivery steps. ${stepLabel(progress)}`}>
    {stepCells(progress).map((c, i) => {
      const spec = c.reached ? DELIVERY_STEP[c.step] : { ...DELIVERY_STEP[c.step], tone: c.current ? "amber" as const : "gray" as const, icon: CircleDashed };
      return <li key={c.step} data-tone={c.reached ? "green" : c.current ? "amber" : undefined} aria-current={c.current ? "step" : undefined}>
        <StatusIcon spec={spec} />
        <span className="milestone-strip-text"><span className="milestone-strip-title">{i + 1}. {DELIVERY_STEP[c.step].label}</span>
          <span className="milestone-strip-state">{c.reached ? "Reached" : c.current ? `Next: ${STEP_GOAL[c.step].toLowerCase()}` : "Not yet"}</span></span>
      </li>;
    })}
  </ol>;
}

/** The finish line as the page's anchor: what done means, how far along it is, and how far behind. */
export function FinishLineSummary({ data, now }: { data: ProjectIntel; now: number }) {
  const p = data.plan.progress;
  const target = p.targetDate ? `Target ${p.targetDate} (${dueState(p.targetDate, now).label.replace(/ \(\d{4}-\d{2}-\d{2}\)$/, "")})` : "No target date";
  const score = p.confirmed && !p.delivered ? p.behind?.score ?? null : null;
  return <section aria-labelledby="fl-h" className="app-panel finish-panel">
    <div className="finish-panel-top">
      <div className="finish-panel-main">
        <div className="finish-panel-title">
          <StatusTile spec={LANE.finish_line} />
          <Title order={2} id="fl-h">Finish line</Title>
          {!p.confirmed && <StatusMark spec={{ ...MOVE_KIND.confirm_finish_line, label: "Not confirmed" }} strong />}
          {p.waitingOnClient && <StatusMark spec={MOVE_KIND.chase}>Waiting on client</StatusMark>}
          {p.overdue && <StatusMark spec={PROMISE_GROUP.overdue} strong>Overdue</StatusMark>}
          <HelpTip label="How done and behind are counted">
            <p>Done counts only what you verified. The finish-line items share 70%. Going live, the client using it and their sign-off add 10% each.</p>
            <p>Behind mixes three parts: time used against work done (50%), how far from delivered (30%) and days since you last verified or marked a step (20%). With no target date, the last two count 60% and 40%.</p>
            <p>70 or more reads far behind (red), 40 to 69 behind (amber), under 40 on pace (blue).</p>
          </HelpTip>
        </div>
        <p className={data.outcome ? "finish-outcome" : "finish-outcome is-missing"}>{data.outcome ? data.outcome.desiredOutcome : "Not written down yet. Until you confirm it, DAVE suggests no tasks."}</p>
        <Text size="sm" c="dimmed">{target}{p.startDate ? ` · Started ${p.startDate}` : ""}</Text>
      </div>
      <div className="finish-panel-side">
        <DoneMeter progress={p} />
        {score !== null && <BehindDial score={score} size={60} />}
      </div>
    </div>
    <div className="finish-panel-steps">
      <StepStrip progress={p} />
      {p.behind && <Text size="sm" c="dimmed">Behind {p.behind.score}: {behindLine(p)}</Text>}
    </div>
  </section>;
}

// ---- moves -------------------------------------------------------------------------------------------------

type PlanProps = { data: ProjectIntel; busy: string | null; run: Run; reveal: (key: string) => void };

export function Moves({ data, busy, run, reveal, revealed }: PlanProps & { revealed: Reveal | null }) {
  const moves = data.plan.moves;
  const { shown, more } = visibleMoves(moves);
  const [moreOpen, setMoreOpen] = useState(false);
  const hidden = more.map(m => `move:${m.id}`).join("|");
  useEffect(() => { if (revealed && hidden.split("|").includes(revealed.key)) setMoreOpen(true); }, [revealed, hidden]);
  const row = (m: Move) => <MoveRow key={m.id} m={m} data={data} busy={busy} run={run} reveal={reveal} />;
  return <section aria-labelledby="moves-h" className="app-panel">
    <PanelHead id="moves-h" title="Your moves" spec={moves.length ? MOVE_KIND.decide : { ...MOVE_KIND.decide, tone: "gray" }} count={moves.length} countTone="amber"
      note={moves.length ? "Only you can do these. Each one unblocks the tasks below." : undefined} />
    {!moves.length ? <Text c="dimmed" className="panel-empty">Nothing needs you right now.</Text> : <ol className="plan-list">{shown.map(row)}</ol>}
    {more.length > 0 && <details className="quiet-details plan-more" open={moreOpen} onToggle={e => setMoreOpen(e.currentTarget.open)}>
      <summary>{plural(more.length, "more move")}</summary><ol className="plan-list">{more.map(row)}</ol>
    </details>}
  </section>;
}

function draftOf(p: Proposal | null): { text: string; criteria: string[] } | null {
  if (!p || p.kind !== "outcome_draft" || typeof p.patch.desiredOutcome !== "string") return null;
  const raw = p.patch.acceptanceCriteria;
  return { text: p.patch.desiredOutcome, criteria: Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [] };
}

function MoveRow({ m, data, busy, run, reveal }: PlanProps & { m: Move }) {
  const spec = MOVE_KIND[m.kind];
  const key = `move:${m.id}`;
  const working = busy === key;
  const off = !!busy && !working;
  const pid = data.projectId;
  const [goalOpen, setGoalOpen] = useState(false);
  const [date, setDate] = useState("");
  const proposal = m.proposalId ? data.proposals.find(p => p.id === m.proposalId) ?? null : null;
  const go = (work: () => Promise<ProjectIntel>) => run(key, work);
  const decide = (accept: boolean, lane?: Lane) => {
    const id = m.proposalId;
    if (id) void go(async () => { await (accept ? intelApi.accept(id, undefined, lane) : intelApi.reject(id)); return intelApi.project(pid); });
  };
  const ok = (label: string, onClick: () => void, color?: string) =>
    <Button size="xs" color={color} leftSection={<Check size={14} aria-hidden="true" />} loading={working} disabled={off} onClick={onClick}>{label}</Button>;
  const quiet = (label: string, onClick: () => void, icon?: ReactNode) =>
    <Button size="xs" variant="default" leftSection={icon} disabled={!!busy} onClick={onClick}>{label}</Button>;
  const reject = <Button size="xs" variant="subtle" color="red" leftSection={<X size={14} aria-hidden="true" />} disabled={!!busy} onClick={() => decide(false)} aria-label={`Reject: ${m.title}`}>Reject</Button>;

  let actions: ReactNode = null;
  let more: ReactNode = null;
  switch (m.kind) {
    case "confirm_finish_line": {
      const draft = draftOf(proposal);
      actions = <>{m.proposalId && draft && ok("Confirm DAVE's draft", () => decide(true))}{quiet(draft ? "Edit it first" : "Write it", () => reveal("finish-line"))}</>;
      if (draft) more = <blockquote className="provenance-quote draft-quote"><Text size="sm">{draft.text}</Text>{draft.criteria.length > 0 && <Checklist lines={draft.criteria} />}</blockquote>;
      break;
    }
    case "decide":
      actions = m.proposalKind === "new_requirement"
        ? <><span className="visually-hidden">File it:</span>{ok("Finish line", () => decide(true, "finish_line"))}{quiet("Extra", () => decide(true, "extra"))}{quiet("Phase 2", () => decide(true, "phase2"))}{reject}</>
        : <>{ok("Accept", () => decide(true))}{reject}</>;
      if (proposal?.provenance.length) more = <details className="quiet-details"><summary>Where this came from ({proposal.provenance.length})</summary><ProvenanceList items={proposal.provenance} now={Date.now()} /></details>;
      break;
    case "chase":
      if (m.itemId) {
        const itemId = m.itemId;
        actions = <>{ok("They sent it", () => void go(() => intelApi.patchItem(itemId, { status: "done" })))}{quiet("Show it", () => reveal(`item:${itemId}`))}</>;
      }
      break;
    case "verify":
      if (m.itemId) {
        const itemId = m.itemId;
        actions = <>{ok("Verified", () => void go(() => intelApi.verifyItem(itemId)), "green")}{quiet("Not right", () => void go(() => intelApi.reopenItem(itemId)), <X size={14} aria-hidden="true" />)}</>;
        if (m.doneWhen.length) more = <Checklist lines={m.doneWhen} />;
      }
      break;
    case "rethink":
      if (m.itemId) {
        const itemId = m.itemId;
        const item = data.items.find(i => i.id === itemId);
        actions = <>{quiet(goalOpen ? "Close" : "Edit goal", () => setGoalOpen(o => !o))}<Button size="xs" variant="default" loading={working} disabled={off} onClick={() => void go(() => intelApi.patchItem(itemId, { lane: "phase2" }))}>Move to Phase 2</Button></>;
        if (goalOpen) more = <GoalForm itemId={itemId} goal={item?.goal ?? ""} busy={busy} run={run} onDone={() => setGoalOpen(false)} />;
      }
      break;
    case "step":
      if (m.step) { const step = m.step; actions = ok("Mark reached", () => void go(() => intelApi.setStep(pid, step, true))); }
      break;
    case "demo":
      actions = ok("Shown to the client", () => void go(() => intelApi.markDemo(pid)));
      break;
    case "target_date": {
      const set = (targetDate: string) => void go(() => intelApi.setSchedule(pid, { targetDate })).then(done => { if (done) setDate(""); });
      const suggested = m.suggestedDate;
      actions = suggested ? ok(`Use ${suggested}`, () => set(suggested)) : null;
      more = <Group gap="xs" align="flex-end" data-intel-editing={date ? true : undefined}>
        <TextInput size="xs" type="date" label={suggested ? "Or pick another date" : "Target date"} value={date} onChange={e => setDate(e.currentTarget.value)} />
        <Button size="xs" variant="default" disabled={!date || !!busy} onClick={() => set(date)}>Set date</Button>
      </Group>;
      break;
    }
  }
  return <PlanRow id={revealId(key)} tone={railTone(spec.tone)} lead={<StatusTile spec={spec} />} title={m.title}
    sub={<><span className={`plan-kind tone-${spec.tone}`}>{spec.label}</span> · {m.why}</>} actions={actions} more={more} />;
}

/** Inline goal edit. Saving a new goal resets the "Not right" count on the server. */
function GoalForm({ itemId, goal, busy, run, onDone }: { itemId: string; goal: string; busy: string | null; run: Run; onDone: () => void }) {
  const key = `goal:${itemId}`;
  const [value, setValue] = useState(goal);
  return <Group gap="xs" align="flex-end" data-intel-editing wrap="wrap">
    <TextInput size="xs" label="Goal" placeholder="So that the client can…" value={value} onChange={e => setValue(e.currentTarget.value)} maxLength={300} style={{ flex: "1 1 260px", minWidth: 0 }} />
    <Button size="xs" loading={busy === key} disabled={!value.trim() || (!!busy && busy !== key)} onClick={() => void run(key, () => intelApi.patchItem(itemId, { goal: value.trim() })).then(ok => { if (ok) onDone(); })}>Save goal</Button>
    <Button size="xs" variant="subtle" onClick={onDone}>Cancel</Button>
  </Group>;
}

// ---- suggested tasks ---------------------------------------------------------------------------------------

export function TaskList({ data, busy, run, reveal }: PlanProps) {
  const { ready, waiting, sent, copyAll, progress } = data.plan;
  const pid = data.projectId;
  const [last, setLast] = useState<{ ids: string[]; label: string } | null>(null);
  const send = (key: string, ids: string[], label: string) =>
    void run(key, () => intelApi.markSent(pid, ids, true)).then(ok => { if (ok) setLast({ ids, label }); });
  const putBack = (key: string, ids: string[]) =>
    void run(key, () => intelApi.markSent(pid, ids, false)).then(ok => { if (ok) setLast(null); });
  const allIds = ready.map(t => t.itemId);

  return <section aria-labelledby="tasks-h" className="app-panel">
    <PanelHead id="tasks-h" title="Suggested tasks for EZcoder" spec={TASK_STATE.sent} count={ready.length}
      note={progress.confirmed ? `In order. Copying a task marks it as sent. ${BRIEF_NOTICE}` : undefined}
      actions={ready.length > 0 ? <CopyText text={copyAll} label={`Copy all ${plural(ready.length, "task")}`} variant="filled" leftSection={<Copy size={14} aria-hidden="true" />}
        loading={busy === "sent:all"} disabled={!!busy && busy !== "sent:all"}
        onCopied={() => send("sent:all", allIds, plural(allIds.length, "task"))} onMarkSent={() => send("sent:all", allIds, plural(allIds.length, "task"))} /> : undefined} />
    {last && <Group role="status" gap="xs" className="feedback-line panel-feedback">
      <Text size="sm">Copied {last.label} and marked {last.ids.length === 1 ? "it" : "them"} as sent. Paste into EZcoder.</Text>
      <Button size="compact-sm" variant="default" leftSection={<Undo2 size={14} aria-hidden="true" />} loading={busy === "sent:undo"} disabled={!!busy && busy !== "sent:undo"} onClick={() => putBack("sent:undo", last.ids)}>Undo</Button>
    </Group>}
    {!progress.confirmed
      ? <Text c="dimmed" className="panel-empty">No tasks until the finish line is confirmed.</Text>
      : !ready.length
        ? <Text c="dimmed" className="panel-empty">Nothing to send: everything is verified, sent or paused.</Text>
        : <ol className="plan-list">{ready.map((t, i) => <TaskRow key={t.itemId} t={t} n={i + 1} busy={busy} run={run} onSend={() => send(`sent:${t.itemId}`, [t.itemId], `task ${i + 1}`)} />)}</ol>}
    {waiting.length > 0 && <StatusGroup spec={TASK_STATE.waiting} title="Paused until you answer" count={waiting.length}>
      <ul className="plan-list">{waiting.map(t => <PlanRow key={t.itemId} lead={<StatusTile spec={TASK_STATE.waiting} />} title={t.build} sub={t.waitingOn ?? "Paused"}
        actions={t.waitingMoveId ? <Button size="xs" variant="default" rightSection={<ArrowRight size={14} aria-hidden="true" />} onClick={() => t.waitingMoveId && reveal(`move:${t.waitingMoveId}`)} aria-label={`Answer what pauses: ${t.build}`}>Answer it</Button> : undefined} />)}</ul>
    </StatusGroup>}
    {sent.length > 0 && <StatusGroup spec={TASK_STATE.sent} title="Sent to EZcoder" count={sent.length} open={false}>
      <ul className="plan-list">{sent.map(t => <PlanRow key={t.itemId} lead={<StatusTile spec={TASK_STATE.sent} />} title={t.build} sub={t.orderReason}
        actions={t.sentAt ? <Button size="xs" variant="subtle" loading={busy === `sent:${t.itemId}`} disabled={!!busy && busy !== `sent:${t.itemId}`} onClick={() => putBack(`sent:${t.itemId}`, [t.itemId])} aria-label={`Put back: ${t.build}`}>Put back</Button> : undefined} />)}</ul>
    </StatusGroup>}
  </section>;
}

function TaskRow({ t, n, busy, run, onSend }: { t: SuggestedTask; n: number; busy: string | null; run: Run; onSend: () => void }) {
  const key = `sent:${t.itemId}`;
  const [goalOpen, setGoalOpen] = useState(false);
  return <PlanRow lead={<span className="num-tile" aria-hidden="true">{n}</span>} title={<><span className="visually-hidden">Task {n}: </span>{t.build}</>}
    sub={<><span className={t.goalDrafted ? "tone-violet" : undefined}>{t.goal}</span>{t.goalDrafted && <span className="quiet-tag tone-violet"> · DAVE's draft</span>} · <span>{t.orderReason}</span></>}
    actions={<CopyText text={t.text} label={`Copy task ${n}`} size="xs" loading={busy === key} disabled={!!busy && busy !== key} onCopied={onSend} onMarkSent={onSend} />}
    more={<details className="quiet-details"><summary>Why, done when and the exact text</summary>
      <Stack gap={6} mt={6}>
        <Text size="sm"><strong>Why:</strong> {t.why}</Text>
        <div><Text size="sm" fw={600}>Done when{t.doneWhenDrafted ? <span className="tone-violet"> (DAVE's draft)</span> : null}</Text><Checklist lines={t.doneWhen} /></div>
        <Group gap="xs">
          <Button size="xs" variant="default" disabled={!!busy} onClick={() => setGoalOpen(o => !o)}>{goalOpen ? "Close" : "Edit goal"}</Button>
          <Button size="xs" variant="subtle" disabled={!!busy} onClick={() => void run(`lane:${t.itemId}`, () => intelApi.patchItem(t.itemId, { lane: "extra" }))}>Not on the finish line</Button>
        </Group>
        {goalOpen && <GoalForm itemId={t.itemId} goal={t.goalDrafted ? "" : t.goal} busy={busy} run={run} onDone={() => setGoalOpen(false)} />}
        <Textarea aria-label={`Task ${n}: exact text`} readOnly value={t.text} autosize minRows={4} maxRows={14} />
      </Stack>
    </details>} />;
}

// ---- bells & whistles --------------------------------------------------------------------------------------

export function Extras({ data, busy, run }: Omit<PlanProps, "reveal">) {
  const { extras, extrasCopy } = data.plan;
  if (!extras.length) return null;
  return <section aria-label="Bells and whistles" className="app-panel">
    <StatusGroup spec={LANE.extra} title="Bells & whistles" count={extras.length} open={false} note="Off the finish line; never suggested as tasks"
      actions={<CopyText text={extrasCopy} label="Copy list for the client" size="xs" />}>
      <ul className="plan-list">{extras.map(t => {
        const key = `lane:${t.itemId}`;
        const other: Lane = t.lane === "phase2" ? "extra" : "phase2";
        const spec = t.laneGuessed ? guessSpec(t.lane) : LANE[t.lane];
        return <PlanRow key={t.itemId} tone={t.laneGuessed ? "violet" : undefined} lead={<StatusTile spec={spec} />} title={t.build}
          sub={<><span className={`plan-kind tone-${spec.tone}`}>{spec.label}</span> · {t.goal}</>}
          actions={<>
            <Button size="xs" variant="default" loading={busy === key} disabled={!!busy && busy !== key} onClick={() => void run(key, () => intelApi.patchItem(t.itemId, { lane: "finish_line" }))}>Move to finish line</Button>
            <Button size="xs" variant="subtle" disabled={!!busy} onClick={() => void run(key, () => intelApi.patchItem(t.itemId, { lane: other }))}>{other === "phase2" ? "Phase 2" : "Extras"}</Button>
          </>} />;
      })}</ul>
    </StatusGroup>
  </section>;
}
