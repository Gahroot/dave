import { useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Group, List, Modal, NativeSelect, Stack, Text } from "@mantine/core";
import { Calendar, ExternalLink, FileText, Folder, Lightbulb, Sparkles, Trash2, Users } from "lucide-react";
import { StatusMark } from "../components/Status.tsx";
import { ITEM_KIND, MEETING_STATUS as MEETING_MARK } from "../status.ts";
import type { MeetingDetail as Detail, MeetingItem, MeetingsState } from "../../meetings/types.ts";
import { deliveryApi } from "../delivery-api.ts";
import { IDEAS_LABEL, ITEM_KIND_LABELS, MEETING_STATUS_LABELS, splitByStrength } from "../meetings-model.ts";
import { routeLink } from "../navigation.ts";
import { DetailHeader, EmptyState, PanelHead } from "../components/WorkspacePrimitives.tsx";
import { MeetingItemRow, type ItemAction, type ItemStrength } from "../components/MeetingItemRow.tsx";
import { MeetingDisclosure } from "../components/MeetingDisclosure.tsx";

type Choices = { projects: { id: string; name: string }[] };
const errorText = (e: unknown) => e instanceof Error ? e.message : "Request failed. Retry.";
const KIND_ORDER: MeetingItem["kind"][] = ["commitment", "pain_point", "suggestion", "decision"];

export function MeetingDetail({ recordingId, back, state, onChanged, paused }: {
  recordingId: string; back: string; state: MeetingsState | null; onChanged: () => void; paused: boolean;
}) {
  const [detail, setDetail] = useState<Detail | null>(null), [missing, setMissing] = useState(false);
  const [choices, setChoices] = useState<Choices | null>(null);
  const [project, setProject] = useState(""), [remember, setRemember] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false), [version, setVersion] = useState(0);
  const [reviewing, setReviewing] = useState(false), [agreed, setAgreed] = useState(false), [forgetting, setForgetting] = useState(false);
  const lock = useRef(false);
  const reload = () => setVersion(v => v + 1);

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const [d, c] = await Promise.all([
          deliveryApi<Detail>(`/api/meetings/recordings/${encodeURIComponent(recordingId)}`, undefined, ac.signal),
          deliveryApi<Choices>("/api/meetings/projects", undefined, ac.signal),
        ]);
        if (ac.signal.aborted) return;
        setDetail(d); setChoices(c); setMissing(false); setError("");
        setProject(current => current || d.projectId || "");
      } catch (e) {
        if (ac.signal.aborted) return;
        if (e instanceof Error && "status" in e && (e as { status: number }).status === 404) setMissing(true);
        else setError(errorText(e));
      }
    })();
    return () => ac.abort();
  }, [recordingId, version]);

  // While this meeting is being analyzed, check again every few seconds.
  const analyzing = !!state && (state.analysis.running === recordingId || state.analysis.queued.includes(recordingId));
  useEffect(() => {
    if (!analyzing || paused) return;
    const timer = setTimeout(() => { if (document.visibilityState === "visible") { onChanged(); reload(); } }, 3000);
    return () => clearTimeout(timer);
  }, [analyzing, paused, state, onChanged]);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    if (lock.current) return false;
    lock.current = true; setBusy(true); setError(""); setNotice("");
    try { await fn(); setNotice(done); reload(); onChanged(); return true; }
    catch (e) { setError(errorText(e)); return false; }
    finally { lock.current = false; setBusy(false); }
  };
  const analyze = async (consent: boolean) => {
    const body = consent && state ? { consentVersion: state.analysis.disclosure.version } : {};
    if (await run(() => deliveryApi(`/api/meetings/recordings/${encodeURIComponent(recordingId)}/analyze`, body), "Analysis started. This page updates when it finishes.")) { setReviewing(false); setAgreed(false); }
  };
  const onAction = (item: MeetingItem, action: ItemAction) => void run(() => deliveryApi(`/api/meetings/items/${encodeURIComponent(item.id)}/status`, { action }), "Saved.");
  const onStrength = (item: MeetingItem, strength: ItemStrength) => void run(() => deliveryApi(`/api/meetings/items/${encodeURIComponent(item.id)}/strength`, { strength }),
    strength === "firm" ? "Marked as a promise. It is back in your plan and Inbox." : "Marked as an idea. It no longer counts as a promise.");
  const saveProject = () => void run(() => deliveryApi(`/api/meetings/recordings/${encodeURIComponent(recordingId)}/project`, { projectId: project || null, remember: remember && !!project }), remember ? "Project saved and remembered for this company." : "Project saved.");
  const forget = async () => { if (await run(() => deliveryApi(`/api/meetings/recordings/${encodeURIComponent(recordingId)}/forget`, {}), "Meeting forgotten.")) location.hash = back; };

  if (missing) return <Stack><DetailHeader title="Meeting unavailable" back={back} backLabel="All meetings" /><EmptyState title="This meeting is not in DAVE">It may have been forgotten, or the link is out of date.</EmptyState></Stack>;
  if (!detail) return <Stack><DetailHeader title="Meeting" back={back} backLabel="All meetings" />{error ? <Alert color="red" title="Meeting unavailable" role="alert">{error}</Alert> : <Text role="status">Loading meeting…</Text>}</Stack>;

  const canAnalyze = ["imported", "analyzed", "failed"].includes(detail.status);
  const autoOn = !!state?.analysis.on;
  const openAI = !!state?.analysis.openAIConnected;
  const externalDomains = [...new Set(detail.attendees.filter(a => a.external && a.domain).map(a => a.domain))];
  const link = detail.url ?? detail.shareUrl;
  const when = new Date(detail.startedAt ?? detail.createdAt);
  const minutes = detail.startedAt && detail.endedAt ? Math.round((Date.parse(detail.endedAt) - Date.parse(detail.startedAt)) / 60_000) : null;
  const here = routeLink("meetings", { section: "list", rec: recordingId });
  // Promises, asks and agreed decisions first; ideas wait in a collapsed group and never count.
  const { firm, ideas } = splitByStrength(detail.items);
  const byKind = KIND_ORDER.map(kind => ({ kind, items: firm.filter(i => i.kind === kind) })).filter(g => g.items.length > 0);

  return <Stack gap="md" className="meeting-detail">
    <DetailHeader title={detail.title} back={back} backLabel="All meetings">
      {link && <Button component="a" href={link} target="_blank" rel="noopener noreferrer" variant="default" rightSection={<ExternalLink size={14} aria-hidden="true" />}>Open in Fathom</Button>}
    </DetailHeader>
    <div className="status-line">
      <Text role="status" component="span"><StatusMark spec={analyzing ? { tone: "blue", icon: Sparkles, label: "" } : MEETING_MARK[detail.status]} strong>{analyzing ? "Analyzing now…" : MEETING_STATUS_LABELS[detail.status]}{detail.skipReason ? `: ${detail.skipReason}` : ""}{detail.error ? `: ${detail.error}` : ""}{detail.staleInstructions ? " · Analyzed with older reading instructions" : ""}</StatusMark></Text>
      <StatusMark spec={{ tone: "gray", icon: Calendar, label: "" }}>{when.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}{minutes && minutes > 0 ? ` · ${minutes} min` : ""}</StatusMark>
      <StatusMark spec={{ tone: "gray", icon: Users, label: "" }}>{detail.attendees.map(a => a.name ?? a.email ?? "Unknown").join(", ") || "No attendee data"}</StatusMark>
    </div>
    {byKind.length > 0 && <div className="count-strip" role="group" aria-label="Found in this meeting">{byKind.map(group => <StatusMark key={group.kind} spec={ITEM_KIND[group.kind]}><strong>{group.items.length}</strong> {ITEM_KIND_LABELS[group.kind].toLowerCase()}{group.items.length > 1 ? "s" : ""}</StatusMark>)}</div>}
    {error && <Alert color="red" title="Action needs attention" role="alert">{error}</Alert>}
    {notice && <Text size="sm" role="status" className="feedback-line">{notice}</Text>}

    <Group gap="xs">
      {canAnalyze && !analyzing && <Button leftSection={<Sparkles size={16} aria-hidden="true" />} disabled={busy || !openAI} onClick={() => autoOn ? void analyze(false) : setReviewing(true)}>{detail.status === "analyzed" ? "Analyze again" : "Analyze meeting"}</Button>}
      {(detail.status === "skipped" || detail.status === "unavailable") && <Button variant="default" disabled={busy} onClick={() => void run(() => deliveryApi(`/api/meetings/recordings/${encodeURIComponent(recordingId)}/retry`, {}), detail.transcriptBytes ? "Included. You can analyze it now." : "DAVE will fetch the transcript on the next check.")}>{detail.transcriptBytes ? "Include this meeting" : "Import transcript anyway"}</Button>}
      <Button variant="subtle" color="red" leftSection={<Trash2 size={16} aria-hidden="true" />} disabled={busy} onClick={() => setForgetting(true)}>Forget meeting</Button>
    </Group>
    {canAnalyze && !openAI && <Text size="sm">To analyze meetings, connect or restore OpenAI in <a href={routeLink("connections")}>Connections</a>.</Text>}

    <section aria-labelledby="meeting-project-title" className="app-panel">
      <PanelHead id="meeting-project-title" title="Project" spec={{ tone: detail.projectId ? "blue" : "gray", icon: Folder, label: "" }} />
      <Stack gap="xs" className="panel-body is-form"><NativeSelect label="This meeting is about" value={project} onChange={e => setProject(e.currentTarget.value)} disabled={busy}
        data={[{ value: "", label: "No project" }, ...(choices?.projects ?? []).map(p => ({ value: p.id, label: p.name }))]} />
      {externalDomains.length > 0 && <Checkbox label={`Use this project for future meetings with ${externalDomains.map(d => `@${d}`).join(", ")}`} checked={remember} disabled={busy || !project} onChange={e => setRemember(e.currentTarget.checked)} />}
      <Group><Button variant="default" disabled={busy || (project === (detail.projectId ?? "") && !remember)} onClick={saveProject}>Save project</Button></Group>
    </Stack></section>

    {detail.summary && <section aria-labelledby="meeting-summary-title" className="app-panel">
      <PanelHead id="meeting-summary-title" title={detail.summary.headline} spec={{ tone: "gray", icon: FileText, label: "" }} />
      <Stack gap="xs" className="panel-body">
        {detail.summary.overview && <Text className="meeting-prose">{detail.summary.overview}</Text>}
        {detail.summary.direction.length > 0 && <><Text fw={600} size="sm">Direction</Text><List size="sm" spacing={4}>{detail.summary.direction.map(d => <List.Item key={d}>{d}</List.Item>)}</List></>}
      </Stack>
    </section>}

    {byKind.map(group => <section key={group.kind} aria-labelledby={`kind-${group.kind}`} className="meeting-group app-panel">
      <PanelHead id={`kind-${group.kind}`} title={`${ITEM_KIND_LABELS[group.kind]}${group.items.length > 1 ? "s" : ""}`} spec={ITEM_KIND[group.kind]} count={group.items.length} />
      <ul className="meeting-list">{group.items.map(item => <MeetingItemRow key={item.id} item={item} busy={busy} onAction={onAction} onStrength={onStrength} returnTo={here} showMeeting={false} showKind={false} showProject={item.projectId !== detail.projectId} />)}</ul>
    </section>)}
    {ideas.length > 0 && <details className="panel-disclosure meeting-ideas app-panel" aria-label={IDEAS_LABEL}>
      <summary><Lightbulb size={16} aria-hidden="true" /> {IDEAS_LABEL} ({ideas.length})</summary>
      <Text size="sm" c="dimmed" className="panel-body">Maybes and brainstorming from this meeting. They make no Inbox rows, follow-up checks or plan commitments until you mark one as a promise.</Text>
      <ul className="meeting-list">{ideas.map(item => <MeetingItemRow key={item.id} item={item} busy={busy} onAction={onAction} onStrength={onStrength} returnTo={here} showMeeting={false} showProject={item.projectId !== detail.projectId} />)}</ul>
    </details>}
    {detail.status === "analyzed" && byKind.length === 0 && ideas.length === 0 && <div className="app-panel"><EmptyState title="Nothing to track from this meeting">No promises, client asks or decisions about project work were found.</EmptyState></div>}

    <Modal opened={reviewing && !!state} onClose={() => { setReviewing(false); setAgreed(false); }} title="Analyze this meeting?" centered size="lg">
      {state && <Stack>
        <Text size="sm">Automatic analysis is off. This sends only this meeting, once.</Text>
        <MeetingDisclosure disclosure={{ ...state.analysis.disclosure, sections: state.analysis.disclosure.sections.slice(0, 1) }} />
        <Checkbox label="Send this meeting to my OpenAI connection" checked={agreed} onChange={e => setAgreed(e.currentTarget.checked)} />
        <Group><Button variant="default" onClick={() => { setReviewing(false); setAgreed(false); }}>Cancel</Button><Button disabled={!agreed || busy} onClick={() => void analyze(true)}>Analyze meeting</Button></Group>
      </Stack>}
    </Modal>
    <Modal opened={forgetting} onClose={() => setForgetting(false)} title="Forget this meeting?" centered>
      <Stack>
        <Text>DAVE deletes its transcript, analysis, promises and client asks, and will not import it again. The recording stays in Fathom.</Text>
        <Group><Button variant="default" onClick={() => setForgetting(false)}>Keep meeting</Button><Button color="red" disabled={busy} onClick={() => { setForgetting(false); void forget(); }}>Forget meeting</Button></Group>
      </Stack>
    </Modal>
  </Stack>;
}
