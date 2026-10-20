import { useEffect, useRef, useState } from "react";
import { Alert, Text } from "react-native";
import { Check, Pause, Play, RefreshCw, Sparkles, Unplug } from "lucide-react-native";
import { HISTORY_DAYS, type HistoryDays, type MeetingsState } from "../../../../src/meetings/types.ts";
import { relative } from "../../../../src/ui/format.ts";
import { connectionSummary, runSummary } from "../../../../src/ui/meetings-model.ts";
import { CONNECTION } from "../../../../src/ui/status.ts";
import { describeError } from "../../lib/api";
import { useApi } from "../../lib/connection";
import { useResource } from "../../lib/useResource";
import { Banner, Button, Disclosure, Inline, Muted, Panel, SelectField, Small, Stack, TextField, tick } from "../../ui/primitives";
import { StatusMark } from "../../ui/status";
import { text } from "../../ui/theme";
import { ConsentSheet, MeetingDisclosure, OpenAIMissing } from "../meetings/MeetingDisclosure";
import { analysisStatusText, fathomMark, meetingsActive, splitList, syncProblemText } from "../meetings/model";

const HISTORY_OPTIONS = HISTORY_DAYS.map((d) => ({ value: String(d) as `${HistoryDays}`, label: `Last ${d} days` }));

/** Fathom connection, meeting import settings and the analysis switch. */
export function FathomCard() {
  const api = useApi();
  const [active, setActive] = useState(false);
  const resource = useResource<MeetingsState>("/api/meetings/status", { pollMs: active ? 3000 : undefined });
  const state = resource.data;
  useEffect(() => setActive(meetingsActive(state)), [state]);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  // The key lives only in this field's memory until sent; it is never stored on the phone.
  const [key, setKey] = useState("");
  const [email, setEmail] = useState(""), [aliases, setAliases] = useState(""), [ignore, setIgnore] = useState(""), [history, setHistory] = useState<HistoryDays>(30);
  const [reviewing, setReviewing] = useState(false);
  const lock = useRef(false), loaded = useRef(false);

  useEffect(() => {
    if (!state || loaded.current) return;
    loaded.current = true;
    setEmail(state.settings.fathomEmail); setAliases(state.settings.nameAliases.join(", "));
    setIgnore(state.settings.ignoreWords.join(", ")); setHistory(state.settings.historyDays);
  }, [state]);

  const run = async (action: () => Promise<MeetingsState>, done = "") => {
    if (lock.current) return false;
    lock.current = true; setBusy(true); setError(""); setNotice("");
    try { resource.setData(await action()); if (done) setNotice(done); tick(); return true; }
    catch (e) { setError(describeError(e, "Fathom action failed. Retry.")); void resource.reload(); return false; }
    finally { setBusy(false); lock.current = false; }
  };
  const post = (path: string, body: object) => api.post<MeetingsState>(path, body);
  const saveKey = () => run(async () => { const value = await post("/api/meetings/key", { key }); setKey(""); return value; }, "Key saved in your Keychain and confirmed with Fathom.");
  const saveSettings = () => run(() => post("/api/meetings/settings", { fathomEmail: email.trim(), nameAliases: splitList(aliases), ignoreWords: splitList(ignore), historyDays: history }), "Settings saved.");
  const setAnalysis = async (on: boolean) => {
    const ok = await run(() => post("/api/meetings/analysis", on ? { on, consentVersion: state?.analysis.disclosure.version } : { on }), on ? "Automatic analysis is on." : "Automatic analysis is off.");
    if (ok) setReviewing(false);
  };
  const disconnect = () => {
    const go = (deleteMeetings: boolean) => void run(() => post("/api/meetings/disconnect", { deleteMeetings }), "Fathom disconnected.");
    Alert.alert("Disconnect Fathom?", "This removes the key from your Keychain, stops importing and turns off analysis.\n\nKeep imported meetings, with their promises and client asks, or delete them, including transcripts, promises and client asks.", [
      { text: "Stay connected", style: "cancel" },
      { text: "Disconnect", onPress: () => go(false) },
      { text: "Disconnect and delete", style: "destructive", onPress: () => go(true) },
    ], { cancelable: true });
  };

  const connected = !!state?.key.saved && !!state.settings.connectedAt && state.key.state !== "invalid";
  const lastRun = state?.runs[0];
  const analysis = state?.analysis;
  const problem = state ? syncProblemText(state.sync, new Date()) : null;

  return <Panel title="Fathom meetings" spec={fathomMark(state)}>
    <Text style={[text.small, { fontWeight: "600" }]} accessibilityLiveRegion="polite">{state ? connectionSummary(state) : resource.error ? "Fathom status unavailable." : "Loading status…"}{state?.sync.lastSuccessAt ? ` Last checked ${relative(state.sync.lastSuccessAt)}.` : ""}</Text>
    {problem && <StatusMark spec={CONNECTION.error}>{problem}</StatusMark>}
    {lastRun && <Muted>Last check {relative(lastRun.finishedAt)}: {runSummary(lastRun)}</Muted>}
    {resource.error && !state ? <Banner tone="red" title="Fathom needs attention" message={resource.error} action={<Button title="Retry" compact onPress={() => void resource.reload()} />} /> : null}
    {error ? <Banner tone="red" title="Fathom needs attention" message={error} /> : null}
    {notice ? <Text style={text.small} accessibilityLiveRegion="polite">{notice}</Text> : null}

    {state && <>
      <TextField label={state.key.saved ? "Replace Fathom API key" : "Fathom API key"} help="Sent to your Mac and stored only in its macOS Keychain. DAVE never shows it again, and this phone does not keep it."
        value={key} onChangeText={setKey} secureTextEntry autoComplete="off" autoCorrect={false} autoCapitalize="none" textContentType="none" importantForAutofill="no" editable={!busy} />
      <Inline><Button title={state.key.saved ? "Replace key" : "Save and check key"} icon={Check} variant={state.key.saved ? "secondary" : "primary"} disabled={busy || !key.trim()} onPress={() => void saveKey()} /></Inline>
    </>}

    {state?.key.saved && <Stack>
      <TextField label="Your Fathom email" help="DAVE imports only meetings you recorded with this account." value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} editable={!busy} />
      <TextField label="Your name as it appears in calls" help="Separate several names with commas." value={aliases} onChangeText={setAliases} editable={!busy} />
      <SelectField label="Import history when connecting" value={`${history}`} options={HISTORY_OPTIONS} onChange={(v) => setHistory(Number(v) as HistoryDays)} disabled={busy} />
      <TextField label="Skip meetings whose title contains" help="Separate words with commas, for example: standup, 1:1" value={ignore} onChangeText={setIgnore} autoCapitalize="none" editable={!busy} />
      <Inline><Button title="Save settings" icon={Check} disabled={busy} onPress={() => void saveSettings()} /></Inline>
    </Stack>}

    {state?.key.saved && <Inline>
      <Button title="Check Fathom now" icon={RefreshCw} disabled={busy || !connected || !state.settings.fathomEmail || state.sync.running} onPress={() => void run(() => post("/api/meetings/sync", {}), "Checking Fathom now.")} />
      <Button title={state.settings.paused ? "Resume automatic import" : "Pause automatic import"} icon={state.settings.paused ? Play : Pause} disabled={busy || !connected}
        onPress={() => void run(() => post("/api/meetings/settings", { paused: !state.settings.paused }))} />
      <Button title="Disconnect Fathom" icon={Unplug} variant="danger-subtle" disabled={busy} onPress={disconnect} />
    </Inline>}

    {analysis && <Stack gap={8}>
      <StatusMark strong spec={{ tone: analysis.on ? "green" : analysis.consentOutdated ? "amber" : "gray", icon: Sparkles, label: "" }}>Meeting analysis</StatusMark>
      <Small>{analysisStatusText(analysis)}</Small>
      <Disclosure title="What DAVE sends"><MeetingDisclosure disclosure={analysis.disclosure} /></Disclosure>
      <Inline>{analysis.on
        ? <Button title="Turn off analysis" variant="subtle" disabled={busy} onPress={() => void setAnalysis(false)} />
        : <Button title="Review and turn on analysis" variant="primary" disabled={busy} onPress={() => setReviewing(true)} />}</Inline>
    </Stack>}

    {analysis && <ConsentSheet visible={reviewing} title={analysis.disclosure.title} disclosure={analysis.disclosure}
      warning={!analysis.openAIConnected ? <OpenAIMissing /> : undefined}
      agreeLabel="I agree to send this to my OpenAI connection" confirmLabel="Turn on analysis" cancelLabel="Keep analysis off"
      busy={busy} onCancel={() => setReviewing(false)} onConfirm={() => void setAnalysis(true)} />}
  </Panel>;
}
