import { useCallback, useEffect, useRef, useState } from "react";
import { Text } from "react-native";
import type { InstructionsProfile, MeetingRow, MeetingsState } from "../../../../src/meetings/types.ts";
import { describeError } from "../../lib/api";
import { useApi } from "../../lib/connection";
import { useResource } from "../../lib/useResource";
import { Banner, Button, Caption, ErrorState, Inline, LoadingState, Panel, Small, Stack, TextField, confirm, tick } from "../../ui/primitives";
import { text } from "../../ui/theme";
import { ConsentSheet } from "./MeetingDisclosure";
import { consentBody, consentDisclosure } from "./model";

const MAX = 4000;

/** The owner's reading instructions: they steer focus and wording; DAVE's rules stay fixed. */
export function InstructionsPanel({ state, onChanged }: { state: MeetingsState | null; onChanged: () => void }) {
  const api = useApi();
  const profile = useResource<InstructionsProfile>("/api/meetings/instructions");
  const recordings = useResource<{ meetings: MeetingRow[] }>("/api/meetings/recordings");
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const lock = useRef(false);
  const saved = profile.data?.instructions ?? "";
  const value = draft ?? saved;
  const dirty = !!profile.data && draft !== null && draft !== saved;
  const stale = recordings.data?.meetings.filter((m) => m.staleInstructions).length ?? 0;

  // A fresh load replaces an untouched draft only.
  useEffect(() => { if (draft !== null && draft === saved) setDraft(null); }, [draft, saved]);

  const run = useCallback(async (fn: () => Promise<unknown>, done: string, clearDraft = false) => {
    if (lock.current) return false;
    lock.current = true; setBusy(true); setError(""); setNotice("");
    try { await fn(); if (clearDraft) setDraft(null); await Promise.all([profile.reload(), recordings.reload()]); setNotice(done); tick(); onChanged(); return true; }
    catch (e) { setError(describeError(e)); return false; }
    finally { lock.current = false; setBusy(false); }
  }, [profile, recordings, onChanged]);

  const reanalyze = async (consented: boolean) => {
    if (await run(() => api.post("/api/meetings/reanalyze", consentBody(consented, state)), "Re-analysis started for up to 10 meetings, newest first.")) setReviewing(false);
  };

  if (!profile.data) return <Panel title="Reading instructions">
    {profile.error ? <ErrorState title="Instructions unavailable" message={profile.error} onRetry={() => void profile.reload()} /> : <LoadingState label="Loading instructions…" />}
  </Panel>;

  return <Panel title="Reading instructions">
    <Small>Tell DAVE what to look for in your meetings. DAVE's own rules still apply: only project work, exact quotes, and nothing closed without you.</Small>
    <TextField label="Reading instructions" value={value} onChangeText={setDraft} multiline editable={!busy} style={{ minHeight: 200 }}
      help={`${value.length} of ${MAX} characters${profile.data.source === "default" ? " · Using DAVE's default" : ""}`}
      error={value.length > MAX ? `Shorten to ${MAX} characters or fewer` : null} />
    {error ? <Banner tone="red" title="Instructions need attention" message={error} /> : null}
    {notice ? <Text style={text.small} accessibilityLiveRegion="polite">{notice}</Text> : null}
    <Inline>
      <Button title="Save instructions" variant="primary" loading={busy} disabled={!dirty || !value.trim() || value.length > MAX}
        onPress={() => void run(() => api.post("/api/meetings/instructions", { instructions: value }), "Instructions saved. New analyses use them.", true)} />
      <Button title="Reset to default" variant="subtle" disabled={busy || profile.data.source === "default"}
        onPress={() => void (async () => {
          if (await confirm({ title: "Reset reading instructions?", message: "DAVE's default instructions replace yours.", confirmLabel: "Reset to default", destructive: true }))
            await run(() => api.post("/api/meetings/instructions/reset", {}), "Reset to DAVE's default instructions.", true);
        })()} />
      {dirty && <Button title="Discard changes" variant="subtle" disabled={busy} onPress={() => setDraft(null)} />}
    </Inline>
    {stale > 0 && <Stack>
      <Small>{stale} meeting{stale === 1 ? " was" : "s were"} analyzed with older instructions.</Small>
      <Inline><Button title="Analyze up to 10 again" disabled={busy || dirty || !state?.analysis.openAIConnected}
        onPress={() => { if (state?.analysis.on) void reanalyze(false); else setReviewing(true); }} /></Inline>
      {dirty && <Caption>Save your changes first.</Caption>}
      {!state?.analysis.openAIConnected && <Caption>To analyze meetings, connect or restore OpenAI in Connections.</Caption>}
    </Stack>}
    {state && <ConsentSheet visible={reviewing} title="Analyze these meetings again?" intro="Automatic analysis is off. This sends up to 10 meetings, once."
      disclosure={consentDisclosure(state.analysis.disclosure)} agreeLabel="Send these meetings to my OpenAI connection" confirmLabel="Analyze again"
      busy={busy} onCancel={() => setReviewing(false)} onConfirm={() => void reanalyze(true)} />}
  </Panel>;
}
