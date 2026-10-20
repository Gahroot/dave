/** New assignment in three stages (web AgentAssignment). */
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { randomUUID } from "expo-crypto";
import { ArrowLeft, ArrowRight, CircleCheck, CircleDashed, CircleDot, ListChecks, Play, Plus, Terminal, X } from "lucide-react-native";
import { parseChecks, type AgentOverview, type AgentRun, type CheckCommand } from "../../../../src/agents/types.ts";
import type { StatusSpec } from "../../../../src/ui/status.ts";
import { describeError } from "../../lib/api";
import { useApi } from "../../lib/connection";
import { useResource } from "../../lib/useResource";
import {
  Banner, BottomSpacer, Body, Button, Caption, Code, Disclosure, ErrorState, Heading, Inline, LoadingState, Muted, Panel, Row, Screen, SelectField, Small, Stack, TextField,
} from "../../ui/primitives";
import { StatusMark } from "../../ui/status";
import { colors, radius, space } from "../../ui/theme";
import { Checkbox, useDraftGuard } from "./components";
import { STAGES, assignmentValid, checksError as checksErrorOf, commandLine, criterionList, dependencyCandidates } from "./model";

const DONE: StatusSpec = { tone: "green", icon: CircleCheck, label: "Done" };
const CURRENT: StatusSpec = { tone: "blue", icon: CircleDot, label: "Current" };
const TODO: StatusSpec = { tone: "gray", icon: CircleDashed, label: "To do" };
const COMMAND: StatusSpec = { tone: "blue", icon: Terminal, label: "Check" };
const WAITS: StatusSpec = { tone: "gray", icon: ListChecks, label: "Dependency" };

export function AgentAssignmentScreen({ projectId, handoffId, meetingItemId }: { projectId: string | null; handoffId: string | null; meetingItemId: string | null }) {
  const { data, error, loading, reload } = useResource<AgentOverview>("/api/agents");
  if (!data) return <Screen>{error ? <ErrorState title="Connection unavailable" message={`${error} Last loaded state may be out of date.`} onRetry={() => void reload()} /> : loading ? <LoadingState label="Loading runs…" /> : null}</Screen>;
  return <AssignmentForm data={data} projectId={projectId ?? ""} handoffId={handoffId} meetingItemId={meetingItemId} />;
}

function AssignmentForm({ data, projectId, handoffId, meetingItemId }: { data: AgentOverview; projectId: string; handoffId: string | null; meetingItemId: string | null }) {
  const api = useApi();
  const router = useRouter();
  const [project, setProject] = useState(projectId), [title, setTitle] = useState(""), [prompt, setPrompt] = useState(""), [criteria, setCriteria] = useState("");
  const [checks, setChecks] = useState<CheckCommand[]>([]), [deps, setDeps] = useState<string[]>([]), [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [ready, setReady] = useState(!handoffId && !meetingItemId), [stage, setStage] = useState(0);
  const retry = useRef<{ body: string; key: string } | null>(null), lock = useRef(false);
  const release = useDraftGuard(!!title || !!prompt || !!criteria || !!checks.length || !!deps.length);

  // A client idea from a meeting fills an editable draft; nothing is queued until the owner starts it.
  useEffect(() => {
    if (!meetingItemId || handoffId) return;
    let live = true;
    api.get<{ projectId: string; title: string; prompt: string; criteria: string[] }>(`/api/meetings/items/${encodeURIComponent(meetingItemId)}/assignment`)
      .then((v) => { if (live) { setProject(v.projectId); setTitle(v.title); setPrompt(v.prompt); setCriteria(v.criteria.join("\n")); setReady(true); } })
      .catch((e: unknown) => { if (live) setError(describeError(e, "Draft unavailable")); });
    return () => { live = false; };
  }, [api, meetingItemId, handoffId]);
  useEffect(() => {
    if (!handoffId) return;
    let live = true;
    api.get<{ title: string; prompt: string; criteria: string[] }>(`/api/agents/delivery/${encodeURIComponent(projectId)}/${encodeURIComponent(handoffId)}`)
      .then((v) => { if (live) { setTitle(v.title); setPrompt(v.prompt); setCriteria(v.criteria.join("\n")); setReady(true); } })
      .catch((e: unknown) => { if (live) setError(describeError(e, "Assignment unavailable")); });
    return () => { live = false; };
  }, [api, handoffId, projectId]);

  const list = criterionList(criteria);
  const valid = assignmentValid({ ready, project, title, prompt, criteria });
  const checksError = checksErrorOf(checks);
  const changeCheck = (index: number, patch: Partial<CheckCommand>) => { setChecks((values) => values.map((value, i) => i === index ? { ...value, ...patch } : value)); setAck(false); };
  const candidates = dependencyCandidates(data.runs);
  const projectName = data.projects.find((p) => p.id === project)?.name;

  const submit = async () => {
    if (lock.current) return; lock.current = true; setBusy(true); setError("");
    try {
      const value = { projectId: project, title, prompt, criteria: list, checks: parseChecks(checks), dependencies: deps, handoffId, authorizeExecution: ack };
      const body = JSON.stringify(value); if (retry.current?.body !== body) retry.current = { body, key: randomUUID() };
      const run = await api.post<AgentRun>("/api/agents/runs", { ...value, requestKey: retry.current.key });
      if (meetingItemId) {
        // Same request key on retry: the server returns the same run, so only the link is retried.
        try { await api.post(`/api/meetings/items/${encodeURIComponent(meetingItemId)}/link`, { runId: run.id }); }
        catch (e) { throw new Error(`Queued, but not yet linked to the client idea: ${describeError(e, "request failed")} Select Queue assignment again to retry the link; no second run is created.`); }
      }
      release();
      router.replace(`/agents/${run.id}`);
    } catch (e) { setError(describeError(e, "Not queued. Your draft is retained.")); } finally { setBusy(false); lock.current = false; }
  };

  return <Screen>
    <Panel>
      <View accessibilityLabel={`Step ${stage + 1} of 3`}>
        <Stack gap={space.xs}>{STAGES.map((label, index) => <StatusMark key={label} spec={index < stage ? DONE : index === stage ? CURRENT : TODO} strong={index === stage}>{label}</StatusMark>)}</Stack>
      </View>
      <Heading>{STAGES[stage] ?? ""}</Heading>
      {error && <Banner tone="red" title="Not queued" message={error} />}
      {!ready && !error && <LoadingState label="Loading the prepared assignment…" />}
    </Panel>

    {stage === 0 && <Panel title="Assignment">
      <SelectField label="Project" placeholder="Choose a project" value={project || null} disabled={!!handoffId || busy}
        options={data.projects.map((p) => ({ value: p.id, label: p.name }))} onChange={(v) => { setProject(v); setAck(false); }} />
      <TextField label="Outcome in one line" value={title} maxLength={200} editable={!handoffId && !busy} onChangeText={(v) => { setTitle(v); setAck(false); }} />
      <TextField label="Assignment" multiline value={prompt} maxLength={24000} editable={!handoffId && !busy} onChangeText={(v) => { setPrompt(v); setAck(false); }} />
      <TextField label="What proves it is done (one criterion per line)" help="Up to 12 criteria, 2,000 characters each." multiline value={criteria} maxLength={12000}
        editable={!handoffId && !busy} onChangeText={(v) => { setCriteria(v); setAck(false); }} />
    </Panel>}

    {stage === 1 && <Panel title="Checks and dependencies" note="Checks run an executable with separate arguments, not a shell command. No checks means explicit manual review.">
      {checks.map((check, index) => <View key={index} style={{ gap: space.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: space.md }}>
        <Small strong>{`Check ${index + 1}`}</Small>
        <TextField label={`Check ${index + 1} label`} maxLength={120} value={check.label} onChangeText={(v) => changeCheck(index, { label: v })} />
        <TextField label={`Check ${index + 1} executable`} help="For example: npm" autoCapitalize="none" autoCorrect={false} maxLength={500} value={check.command} onChangeText={(v) => changeCheck(index, { command: v })} />
        {check.args.map((arg, ai) => <Stack key={ai} gap={space.xs}>
          <TextField label={`Check ${index + 1} argument ${ai + 1}`} autoCapitalize="none" autoCorrect={false} maxLength={2000} value={arg}
            onChangeText={(v) => changeCheck(index, { args: check.args.map((old, i) => ai === i ? v : old) })} />
          <Inline><Button compact variant="danger-subtle" title={`Remove argument ${ai + 1}`} onPress={() => changeCheck(index, { args: check.args.filter((_, i) => i !== ai) })} /></Inline>
        </Stack>)}
        <Inline>
          <Button compact icon={Plus} title="Add argument" disabled={check.args.length >= 30} onPress={() => changeCheck(index, { args: [...check.args, ""] })} />
          <Button compact variant="danger-subtle" icon={X} title={`Remove check ${index + 1}`} onPress={() => { setChecks((values) => values.filter((_, i) => i !== index)); setAck(false); }} />
        </Inline>
      </View>)}
      <Button icon={Plus} title="Add check" disabled={checks.length >= 6} onPress={() => { setChecks((values) => [...values, { label: "", command: "", args: [] }]); setAck(false); }} />
      {!!checksError && <Banner tone="red" title="Check the command fields" message={checksError} />}
      <Disclosure title="Wait for other assignments" count={deps.length}>
        {candidates.map((r) => <Checkbox key={r.id} label={`${r.projectName}: ${r.title}`} checked={deps.includes(r.id)} disabled={!deps.includes(r.id) && deps.length >= 12}
          onChange={(on) => { setDeps(on ? [...deps, r.id] : deps.filter((id) => id !== r.id)); setAck(false); }} />)}
        {!candidates.length && <Muted>No open assignments to wait for.</Muted>}
        <Small>Dependencies must be accepted before this run starts. Acceptance does not merge code between workspaces.</Small>
      </Disclosure>
    </Panel>}

    {stage === 2 && <>
      <Panel title="Review and start">
        {projectName && <Caption>{projectName}</Caption>}
        <Body strong>{title}</Body>
        <Muted>{`${deps.length} dependencies · ${handoffId ? "Linked delivery handoff" : meetingItemId ? "From a client idea in a meeting" : "Standalone assignment"}`}</Muted>
        <Disclosure title="Assignment text"><Body selectable>{prompt}</Body></Disclosure>
      </Panel>
      <Panel title={`Done when (${list.length})`} padded={false}>
        {list.map((value, i) => <Row key={i} title={value} spec={TODO} showRail={false} />)}
      </Panel>
      <Panel title={`Approved checks (${checks.length})`} padded={false}>
        {checks.length ? checks.map((check, i) => <Row key={i} title={check.label || `Check ${i + 1}`} spec={COMMAND} subtitle={<Code>{commandLine(check)}</Code>} />)
          : <Row title="No automated checks" subtitle="You will verify manually before accepting." spec={TODO} />}
      </Panel>
      {!!deps.length && <Panel title={`Waits for (${deps.length})`} padded={false}>
        {deps.map((id) => <Row key={id} title={data.runs.find((run) => run.id === id)?.title ?? id} spec={WAITS} />)}
      </Panel>}
      <Panel>
        <Banner tone="amber" title="Local execution" message="Agents and approved checks can access your machine and network and may incur provider charges. A worktree separates files, not permissions. The original checkout must be clean. DAVE does not copy uncommitted files, install dependencies, or share generated files between workspaces." />
        {!data.settings.enabled && <Banner tone="red" title="Execution is disabled" message="Save this decision explicitly in execution settings before starting work."
          action={<Inline><Button compact title="Open execution settings" onPress={() => router.push("/agents/settings")} /></Inline>} />}
        <Checkbox label="I authorize this assignment and these checks to run locally using my agent account" checked={ack} onChange={setAck} />
      </Panel>
    </>}

    <Panel>
      {stage < 2
        ? <Button variant="primary" icon={ArrowRight} title="Continue" disabled={!valid || stage === 1 && !!checksError} onPress={() => setStage((s) => s + 1)} />
        : <Button variant="primary" icon={Play} title="Queue assignment" loading={busy} disabled={!valid || !!checksError || !data.settings.enabled || !ack} onPress={() => void submit()} />}
      {stage > 0 && <Button icon={ArrowLeft} title="Back" disabled={busy} onPress={() => setStage((s) => s - 1)} />}
      <Button variant="subtle" title="Cancel" onPress={() => router.back()} />
    </Panel>
    <BottomSpacer />
  </Screen>;
}
