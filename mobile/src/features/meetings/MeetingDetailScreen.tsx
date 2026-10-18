import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking, Text } from "react-native";
import { Stack as RouterStack, useFocusEffect, useRouter } from "expo-router";
import { Calendar, ExternalLink, FileText, Folder, Sparkles, Trash2, Users } from "lucide-react-native";
import type { MeetingDetail, MeetingsState } from "../../../../src/meetings/types.ts";
import { ITEM_KIND_LABELS, MEETING_STATUS_LABELS } from "../../../../src/ui/meetings-model.ts";
import { ITEM_KIND, MEETING_STATUS } from "../../../../src/ui/status.ts";
import { ApiError, describeError } from "../../lib/api";
import { useApi } from "../../lib/connection";
import { useResource } from "../../lib/useResource";
import {
  Banner, Button, Divider, EmptyState, ErrorState, Inline, LoadingState, Panel, Screen, SelectField, Small, Stack, Toggle, confirm, tick,
} from "../../ui/primitives";
import { StatusMark } from "../../ui/status";
import { text } from "../../ui/theme";
import { ConsentSheet } from "./MeetingDisclosure";
import { MeetingItemRow } from "./MeetingItemRow";
import { attendeeText, canAnalyze, consentBody, consentDisclosure, durationMinutes, externalDomains, isAnalyzing, itemsByKind, meetingWhen } from "./model";
import { useItemAction } from "./useItemAction";

type Choices = { projects: { id: string; name: string }[] };

export function MeetingDetailScreen({ recordingId }: { recordingId: string }) {
  const api = useApi();
  const router = useRouter();
  const path = `/api/meetings/recordings/${encodeURIComponent(recordingId)}`;
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const status = useResource<MeetingsState>("/api/meetings/status");
  const choices = useResource<Choices>("/api/meetings/projects");
  const state = status.data;
  const [project, setProject] = useState<string | null>(null);
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const lock = useRef(false);

  const load = useCallback(async () => {
    try {
      const d = await api.get<MeetingDetail>(path);
      setDetail(d); setMissing(false); setLoadError("");
      setProject((current) => current ?? d.projectId ?? "");
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setMissing(true);
      else setLoadError(describeError(e));
    }
  }, [api, path]);
  const reloadAll = useCallback(async () => {
    setRefreshing(true);
    try { await Promise.all([load(), status.reload(), choices.reload()]); } finally { setRefreshing(false); }
  }, [load, status, choices]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  // While this meeting is being analyzed, check again every few seconds.
  const analyzing = isAnalyzing(state, recordingId);
  const focused = useRef(true);
  useFocusEffect(useCallback(() => { focused.current = true; return () => { focused.current = false; }; }, []));
  useEffect(() => {
    if (!analyzing) return;
    const timer = setTimeout(() => { if (focused.current && AppState.currentState === "active") { void status.reload(); void load(); } }, 3000);
    return () => clearTimeout(timer);
  }, [analyzing, state, status, load]);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    if (lock.current) return false;
    lock.current = true; setBusy(true); setError(""); setNotice("");
    try { await fn(); setNotice(done); tick(); void load(); void status.reload(); return true; }
    catch (e) { setError(describeError(e)); void load(); return false; }
    finally { lock.current = false; setBusy(false); }
  };
  const items = useItemAction(load);
  const analyze = async (consented: boolean) => {
    if (await run(() => api.post(`${path}/analyze`, consentBody(consented, state)), "Analysis started. This page updates when it finishes.")) setReviewing(false);
  };

  const header = (title: string) => <RouterStack.Screen options={{ title }} />;
  if (missing) return <Screen>{header("Meeting unavailable")}<Panel><EmptyState title="This meeting is not in DAVE" message="It may have been forgotten, or the link is out of date." /></Panel></Screen>;
  if (!detail) return <Screen>{header("Meeting")}{loadError ? <ErrorState title="Meeting unavailable" message={loadError} onRetry={() => void load()} /> : <LoadingState label="Loading meeting…" />}</Screen>;

  const autoOn = !!state?.analysis.on;
  const openAI = !!state?.analysis.openAIConnected;
  const analyzable = canAnalyze(detail.status);
  const domains = externalDomains(detail);
  const link = detail.url ?? detail.shareUrl;
  const minutes = durationMinutes(detail);
  const byKind = itemsByKind(detail.items);
  const chosen = project ?? "";
  const statusText = `${analyzing ? "Analyzing now…" : MEETING_STATUS_LABELS[detail.status]}${detail.skipReason ? `: ${detail.skipReason}` : ""}${detail.error ? `: ${detail.error}` : ""}${detail.staleInstructions ? " · Analyzed with older reading instructions" : ""}`;
  const forget = async () => {
    if (!await confirm({ title: "Forget this meeting?", message: "DAVE deletes its transcript, analysis, promises and client asks, and will not import it again. The recording stays in Fathom.", confirmLabel: "Forget meeting", cancelLabel: "Keep meeting", destructive: true })) return;
    if (await run(() => api.post(`${path}/forget`, {}), "Meeting forgotten.")) router.back();
  };

  return <Screen refreshing={refreshing} onRefresh={() => void reloadAll()}>
    {header(detail.title)}
    <Panel title={detail.title} spec={analyzing ? { tone: "blue", icon: Sparkles, label: "" } : MEETING_STATUS[detail.status]}>
      <Stack gap={6}>
        <Text style={[text.small, { fontWeight: "600" }]} accessibilityLiveRegion="polite">{statusText}</Text>
        <StatusMark spec={{ tone: "gray", icon: Calendar, label: "" }}>{meetingWhen(detail.startedAt ?? detail.createdAt, true)}{minutes ? ` · ${minutes} min` : ""}</StatusMark>
        <StatusMark spec={{ tone: "gray", icon: Users, label: "" }}>{attendeeText(detail)}</StatusMark>
      </Stack>
      {byKind.length > 0 && <Inline gap={12}>{byKind.map((g) => <StatusMark key={g.kind} spec={ITEM_KIND[g.kind]}>{`${g.items.length} ${ITEM_KIND_LABELS[g.kind].toLowerCase()}${g.items.length > 1 ? "s" : ""}`}</StatusMark>)}</Inline>}
      {error ? <Banner tone="red" title="Action needs attention" message={error} /> : null}
      {notice ? <Text style={text.small} accessibilityLiveRegion="polite">{notice}</Text> : null}
      {items.error ? <Banner tone="red" title="Action needs attention" message={items.error} /> : null}
      <Inline>
        {analyzable && !analyzing && <Button title={detail.status === "analyzed" ? "Analyze again" : "Analyze meeting"} icon={Sparkles} variant="primary" loading={busy} disabled={!openAI || !state}
          onPress={() => { if (autoOn) void analyze(false); else setReviewing(true); }} />}
        {(detail.status === "skipped" || detail.status === "unavailable") && <Button title={detail.transcriptBytes ? "Include this meeting" : "Import transcript anyway"} disabled={busy}
          onPress={() => void run(() => api.post(`${path}/retry`, {}), detail.transcriptBytes ? "Included. You can analyze it now." : "DAVE will fetch the transcript on the next check.")} />}
        {link && <Button title="Open in Fathom" icon={ExternalLink} onPress={() => void Linking.openURL(link)} />}
        <Button title="Forget meeting" icon={Trash2} variant="danger-subtle" disabled={busy} onPress={() => void forget()} />
      </Inline>
      {analyzable && !openAI && <Inline><Small>To analyze meetings, connect or restore OpenAI in Connections.</Small><Button title="Connections" variant="subtle" compact onPress={() => router.push("/connections")} /></Inline>}
    </Panel>

    <Panel title="Project" spec={{ tone: detail.projectId ? "blue" : "gray", icon: Folder, label: "" }}>
      <SelectField label="This meeting is about" value={chosen} disabled={busy || !choices.data}
        options={[{ value: "", label: "No project" }, ...(choices.data?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))]}
        onChange={(v) => { setProject(v); if (!v) setRemember(false); }} />
      {choices.error && <Banner tone="red" title="Projects unavailable" message={choices.error} />}
      {domains.length > 0 && <Toggle label={`Use this project for future meetings with ${domains.map((d) => `@${d}`).join(", ")}`} value={remember} disabled={busy || !chosen} onValueChange={setRemember} />}
      <Inline><Button title="Save project" disabled={busy || (chosen === (detail.projectId ?? "") && !remember)}
        onPress={() => void run(() => api.post(`${path}/project`, { projectId: chosen || null, remember: remember && !!chosen }), remember && chosen ? "Project saved and remembered for this company." : "Project saved.")} /></Inline>
    </Panel>

    {detail.summary && <Panel title={detail.summary.headline} spec={{ tone: "gray", icon: FileText, label: "" }}>
      {detail.summary.overview ? <Text style={text.body} selectable>{detail.summary.overview}</Text> : null}
      {detail.summary.direction.length > 0 && <Stack gap={4}>
        <Text style={[text.small, { fontWeight: "600" }]}>Direction</Text>
        {detail.summary.direction.map((d) => <Text key={d} style={text.small} selectable>• {d}</Text>)}
      </Stack>}
    </Panel>}

    {byKind.map((group) => <Panel key={group.kind} title={`${ITEM_KIND_LABELS[group.kind]}${group.items.length > 1 ? "s" : ""}`} spec={ITEM_KIND[group.kind]} count={group.items.length} padded={false}>
      <Stack gap={0}>{group.items.map((item, i) => <Stack key={item.id} gap={0}>{i > 0 && <Divider />}
        <MeetingItemRow item={item} busy={busy || items.busyId === item.id} onAction={items.onAction} onChanged={() => void load()}
          showMeeting={false} showKind={false} showProject={item.projectId !== detail.projectId} /></Stack>)}</Stack>
    </Panel>)}
    {detail.status === "analyzed" && byKind.length === 0 && <Panel><EmptyState title="Nothing to track from this meeting" message="No promises, client asks or decisions about project work were found." /></Panel>}

    {state && <ConsentSheet visible={reviewing} title="Analyze this meeting?" intro="Automatic analysis is off. This sends only this meeting, once."
      disclosure={consentDisclosure(state.analysis.disclosure)} agreeLabel="Send this meeting to my OpenAI connection" confirmLabel="Analyze meeting"
      busy={busy} onCancel={() => setReviewing(false)} onConfirm={() => void analyze(true)} />}
  </Screen>;
}
