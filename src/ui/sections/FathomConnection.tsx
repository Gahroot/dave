import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Checkbox, Group, Modal, NativeSelect, PasswordInput, Radio, Stack, Text, TextInput, Title } from "@mantine/core";
import type { HistoryDays, MeetingsState } from "../../meetings/types.ts";
import { MeetingDisclosure } from "../components/MeetingDisclosure.tsx";
import { deliveryApi } from "../delivery-api.ts";
import { relative } from "../format.ts";
import { connectionSummary, runSummary } from "../meetings-model.ts";
import { Check, KeyRound, Pause, Play, RefreshCw, Sparkles, Unplug } from "lucide-react";
import { StatusIcon, StatusTile } from "../components/Status.tsx";
import { CONNECTION } from "../status.ts";

const errorText = (e: unknown, fallback: string) => e instanceof Error ? e.message : fallback;
const splitList = (value: string): string[] => value.split(",").map(v => v.trim()).filter(Boolean);

/** Fathom connection, meeting import settings and the analysis switch. */
export function FathomConnection() {
  const [state, setState] = useState<MeetingsState | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [key, setKey] = useState("");
  const [email, setEmail] = useState(""), [aliases, setAliases] = useState(""), [ignore, setIgnore] = useState(""), [history, setHistory] = useState<HistoryDays>(30);
  const [disconnecting, setDisconnecting] = useState(false), [keepMeetings, setKeepMeetings] = useState("keep");
  const [reviewing, setReviewing] = useState(false), [agreed, setAgreed] = useState(false);
  const lock = useRef(false), loaded = useRef(false);

  const apply = (value: MeetingsState) => {
    setState(value);
    if (!loaded.current) {
      loaded.current = true;
      setEmail(value.settings.fathomEmail); setAliases(value.settings.nameAliases.join(", "));
      setIgnore(value.settings.ignoreWords.join(", ")); setHistory(value.settings.historyDays);
    }
  };
  const load = async (signal?: AbortSignal) => {
    try { const value = await deliveryApi<MeetingsState>("/api/meetings/status", undefined, signal); if (!signal?.aborted) { apply(value); setError(""); } }
    catch (e) { if (!signal?.aborted) setError(errorText(e, "Fathom status unavailable. Retry.")); }
  };
  useEffect(() => { const ac = new AbortController(); void load(ac.signal); return () => ac.abort(); }, []);
  // While a sync or analysis runs, poll so the card shows when it finishes.
  const active = !!state && (state.sync.running || !!state.analysis.running || state.analysis.queued.length > 0);
  useEffect(() => {
    if (!active) return;
    const ac = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { if (document.visibilityState === "visible") await load(ac.signal); if (!ac.signal.aborted) timer = setTimeout(poll, 3000); };
    timer = setTimeout(poll, 3000);
    return () => { ac.abort(); clearTimeout(timer); };
  }, [active]);

  const run = async (action: () => Promise<MeetingsState>, done = "") => {
    if (lock.current) return false;
    lock.current = true; setBusy(true); setError(""); setNotice("");
    try { apply(await action()); if (done) setNotice(done); return true; }
    catch (e) { setError(errorText(e, "Fathom action failed. Retry.")); return false; }
    finally { setBusy(false); lock.current = false; }
  };
  const saveKey = () => run(async () => { const value = await deliveryApi<MeetingsState>("/api/meetings/key", { key }); setKey(""); return value; }, "Key saved in your Keychain and confirmed with Fathom.");
  const saveSettings = () => run(() => deliveryApi<MeetingsState>("/api/meetings/settings", { fathomEmail: email.trim(), nameAliases: splitList(aliases), ignoreWords: splitList(ignore), historyDays: history }), "Settings saved.");
  const setPaused = (paused: boolean) => run(() => deliveryApi<MeetingsState>("/api/meetings/settings", { paused }));
  const syncNow = () => run(() => deliveryApi<MeetingsState>("/api/meetings/sync", {}), "Checking Fathom now.");
  const disconnect = async () => { if (await run(() => deliveryApi<MeetingsState>("/api/meetings/disconnect", { deleteMeetings: keepMeetings === "delete" }), "Fathom disconnected.")) setDisconnecting(false); };
  const setAnalysis = async (on: boolean) => {
    const ok = await run(() => deliveryApi<MeetingsState>("/api/meetings/analysis", on ? { on, consentVersion: state?.analysis.disclosure.version } : { on }), on ? "Automatic analysis is on." : "Automatic analysis is off.");
    if (ok) { setReviewing(false); setAgreed(false); }
  };

  const connected = !!state?.key.saved && !!state.settings.connectedAt && state.key.state !== "invalid";
  const lastRun = state?.runs[0];
  const analysis = state?.analysis;
  const mark = !state ? CONNECTION.pending : state.key.storageError || state.key.state === "invalid" ? CONNECTION["invalid-key"] : !state.key.saved || !state.settings.connectedAt ? CONNECTION.disconnected : state.sync.lastError ? { ...CONNECTION.error, label: "Connected, last check failed" } : state.settings.paused ? CONNECTION.paused : CONNECTION.connected;
  return <Card withBorder radius="md" padding="md" className="connection-card" data-tone={mark.tone}><Stack gap="sm">
    <Title order={3} className="connection-title"><StatusTile spec={mark} size={18} />Fathom meetings</Title>
    <Text role="status" fw={600}>{state ? connectionSummary(state) : "Loading status…"}{state?.sync.lastSuccessAt ? ` Last checked ${relative(state.sync.lastSuccessAt)}.` : ""}</Text>
    {state?.sync.lastError && <Text size="sm" className="status-line"><StatusIcon spec={CONNECTION.error} />Last problem: {state.sync.lastError}.{state.sync.backoffUntil && Date.parse(state.sync.backoffUntil) > Date.now() ? ` DAVE tries again automatically after ${new Date(state.sync.backoffUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : ""}</Text>}
    {lastRun && <Text size="sm" c="dimmed">Last check {relative(lastRun.finishedAt)}: {runSummary(lastRun)}</Text>}
    {error && <Alert color="red" title="Fathom needs attention" role="alert">{error}</Alert>}
    {notice && <Text size="sm" role="status" className="feedback-line">{notice}</Text>}

    <PasswordInput label={state?.key.saved ? "Replace Fathom API key" : "Fathom API key"} description="Stored only in your macOS Keychain. DAVE never shows it again." leftSection={<KeyRound size={16} aria-hidden="true" />} value={key} onChange={e => setKey(e.currentTarget.value)} autoComplete="off" disabled={busy} />
    <Group><Button variant={state?.key.saved ? "default" : "filled"} leftSection={<Check size={16} aria-hidden="true" />} disabled={busy || !key.trim()} onClick={() => void saveKey()}>{state?.key.saved ? "Replace key" : "Save and check key"}</Button></Group>

    {state?.key.saved && <form className="form-stage" onSubmit={e => { e.preventDefault(); void saveSettings(); }}><Stack gap="sm">
      <TextInput label="Your Fathom email" description="DAVE imports only meetings you recorded with this account." type="email" value={email} onChange={e => setEmail(e.currentTarget.value)} disabled={busy} />
      <TextInput label="Your name as it appears in calls" description="Separate several names with commas." value={aliases} onChange={e => setAliases(e.currentTarget.value)} disabled={busy} />
      <NativeSelect label="Import history when connecting" value={String(history)} onChange={e => setHistory(Number(e.currentTarget.value) as HistoryDays)} disabled={busy}
        data={[{ value: "7", label: "Last 7 days" }, { value: "30", label: "Last 30 days" }, { value: "90", label: "Last 90 days" }]} />
      <TextInput label="Skip meetings whose title contains" description="Separate words with commas, for example: standup, 1:1" value={ignore} onChange={e => setIgnore(e.currentTarget.value)} disabled={busy} />
      <Group><Button type="submit" variant="default" leftSection={<Check size={16} aria-hidden="true" />} disabled={busy}>Save settings</Button></Group>
    </Stack></form>}

    {state?.key.saved && <Group gap="xs">
      <Button variant="default" leftSection={<RefreshCw size={16} aria-hidden="true" />} disabled={busy || !connected || !state.settings.fathomEmail || state.sync.running} onClick={() => void syncNow()}>Check Fathom now</Button>
      <Button variant="default" leftSection={state.settings.paused ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />} disabled={busy || !connected} aria-pressed={state.settings.paused} onClick={() => void setPaused(!state.settings.paused)}>{state.settings.paused ? "Resume automatic import" : "Pause automatic import"}</Button>
      <Button variant="subtle" color="red" leftSection={<Unplug size={16} aria-hidden="true" />} disabled={busy} onClick={() => setDisconnecting(true)}>Disconnect Fathom</Button>
    </Group>}

    {analysis && <section aria-labelledby="meeting-analysis-title"><Stack gap="xs">
      <Title order={4} id="meeting-analysis-title" className="connection-title"><StatusIcon spec={{ tone: analysis.on ? "green" : analysis.consentOutdated ? "amber" : "gray", icon: Sparkles, label: "" }} />Meeting analysis</Title>
      <Text role="status" size="sm">{analysis.on ? "On: new meetings are analyzed automatically." : analysis.consentOutdated ? "Paused: what DAVE sends has changed. Review it to turn analysis back on." : "Off: meetings are imported but not analyzed. You can still analyze one meeting at a time."}{analysis.on && !analysis.openAIConnected ? " OpenAI is not connected, so nothing is sent. Connect or restore it above." : ""}</Text>
      <details className="quiet-details"><summary>What DAVE sends</summary><MeetingDisclosure disclosure={analysis.disclosure} /></details>
      <Group>{analysis.on
        ? <Button variant="subtle" color="dark" disabled={busy} onClick={() => void setAnalysis(false)}>Turn off analysis</Button>
        : <Button disabled={busy} onClick={() => setReviewing(true)}>Review and turn on analysis</Button>}</Group>
    </Stack></section>}

    <Modal opened={reviewing && !!analysis} onClose={() => { setReviewing(false); setAgreed(false); }} title={analysis?.disclosure.title ?? "Meeting analysis"} centered size="lg">
      {analysis && <Stack>
        <MeetingDisclosure disclosure={analysis.disclosure} />
        {!analysis.openAIConnected && <Alert title="OpenAI is not connected">Connect or restore OpenAI above. Until then, nothing is sent even with analysis on.</Alert>}
        <Checkbox label="I agree to send this to my OpenAI connection" checked={agreed} onChange={e => setAgreed(e.currentTarget.checked)} />
        <Group><Button variant="default" onClick={() => { setReviewing(false); setAgreed(false); }}>Keep analysis off</Button><Button disabled={!agreed || busy} onClick={() => void setAnalysis(true)}>Turn on analysis</Button></Group>
      </Stack>}
    </Modal>

    <Modal opened={disconnecting} onClose={() => setDisconnecting(false)} title="Disconnect Fathom?" centered>
      <Stack>
        <Text>This removes the key from your Keychain, stops importing and turns off analysis.</Text>
        <Radio.Group label="Imported meetings" value={keepMeetings} onChange={setKeepMeetings}>
          <Stack gap="xs" mt="xs"><Radio value="keep" label="Keep them, with their promises and client asks" /><Radio value="delete" label="Delete them, including transcripts, promises and client asks" /></Stack>
        </Radio.Group>
        <Group><Button variant="default" onClick={() => setDisconnecting(false)}>Stay connected</Button><Button color="red" disabled={busy} onClick={() => void disconnect()}>{keepMeetings === "delete" ? "Disconnect and delete" : "Disconnect"}</Button></Group>
      </Stack>
    </Modal>
  </Stack></Card>;
}
