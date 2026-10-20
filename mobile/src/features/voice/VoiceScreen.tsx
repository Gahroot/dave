/**
 * The full Talk to DAVE page (port of src/ui/voice/VoicePanel.tsx, variant "page").
 * Mascot + status up top, the conversation in the middle, controls at the bottom.
 * Transcripts, captions, agent text and file names render as plain Text only.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Image, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type ScrollViewInstance } from "react-native";
import { useRouter, type Href } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { AudioLines, Check, CheckCheck, Copy, FileText, Hand, Mic, MicOff, Paperclip, PhoneOff, Send, Settings, ShieldCheck, Undo2, X } from "lucide-react-native";
import { MOOD_LABEL } from "../../../../src/ui/mascot/types.ts";
import { isActive, mascotMood, voiceStatusLabel } from "../../../../src/ui/voice/machine.ts";
import { approvalAnnouncement, type VoiceCard } from "../../../../src/ui/voice/model.ts";
import { MODELS, VOICES, type DocumentMeta, type RealtimeModel, type VoiceHistoryEntry, type VoiceMemory, type VoiceMode, type VoiceName } from "../../../../src/voice/types.ts";
import { describeError } from "../../lib/api";
import { useApi } from "../../lib/connection";
import { DaveMascot } from "../mascot/DaveMascot";
import { LedText } from "../mascot/LedText";
import { MoodGallery } from "../mascot/MoodGallery";
import { BottomSpacer, Button, Caption, Divider, EmptyState, IconButton, LoadingState, Muted, SelectField, Small, Toggle, tick } from "../../ui/primitives";
import { colors, radius, space, text, tints, tones, touch } from "../../ui/theme";
import type { Tone } from "../../../../src/ui/status.ts";
import { chipLabels, documentSummary, historySummary, imageDataUri, webRouteToPhoneHref } from "./model";
import { useVoice, type PickedFile } from "./VoiceProvider";

export function VoiceScreen() {
  const voice = useVoice();
  const router = useRouter();
  const { state } = voice;
  const [draft, setDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const log = useRef<ScrollViewInstance>(null);
  const insets = useSafeAreaInsets();
  const active = isActive(state);
  const live = state.phase === "live";
  const mood = mascotMood(state);

  const detail = voice.error ? voice.error.message
    : state.phase === "idle" || state.phase === "ended" ? (voice.status?.availability.state === "unavailable" ? voice.status.availability.message : state.phase === "ended" ? "Conversation saved. Talk again any time." : "Press Talk and say what matters most this week.")
    : `DAVE is ${MOOD_LABEL[mood]}.`;

  const submit = () => { if (!draft.trim() || !live) return; voice.sendText(draft, { fromUser: true }); setDraft(""); };
  const share = () => {
    Alert.alert("Share with DAVE", "DAVE keeps a copy on your Mac so it can read it.", [
      { text: "Photo library", onPress: () => { void pickPhotos(false).then((f) => { if (f.length) voice.shareFiles(f); }); } },
      { text: "Take a photo", onPress: () => { void pickPhotos(true).then((f) => { if (f.length) voice.shareFiles(f); }); } },
      { text: "PDF or image file", onPress: () => { void pickDocuments().then((f) => { if (f.length) voice.shareFiles(f); }); } },
      { text: "Cancel", style: "cancel" },
    ]);
  };
  const chips = chipLabels(voice.chips, voice.lookingAt);

  return <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? 100 : 0}>
    <View style={styles.top}>
      <View style={styles.hero}>
        <DaveMascot mood={mood} size={120} levels={voice.levels} />
        <View style={styles.heroText}>
          <LedText text={voiceStatusLabel(state)} tone={state.phase === "error" ? "oops" : active ? "lit" : "dim"} />
          <Text style={text.small} accessibilityLiveRegion="polite">{detail}</Text>
          {voice.error?.connect && <Button title="Open Connections" variant="subtle" compact onPress={() => router.push("/connections")} />}
          {voice.error?.settings && <Button title="Open Settings" variant="subtle" compact onPress={() => { void Linking.openSettings(); }} accessibilityHint="Allow microphone access for DAVE, then come back and press Talk" />}
        </View>
      </View>
      {live && voice.approval.on && <View style={[styles.approval, { backgroundColor: tints.amber, borderLeftColor: tones.amber }]} accessibilityRole="summary">
        <ShieldCheck size={16} color={tones.amber} />
        <Text style={[text.small, styles.flex]}>{approvalAnnouncement(true)}</Text>
        <Button title="Turn off" compact onPress={() => voice.setApproval(false)} accessibilityLabel="Turn off Approve all" />
      </View>}
      {chips.length > 0 && <View style={styles.chips} accessibilityLabel="What DAVE sees">
        {chips.map((c) => <View key={c.text} style={[styles.chip, { borderColor: tones[c.tone] }]}><Text style={text.caption}>{c.text}</Text></View>)}
      </View>}
    </View>

    <ScrollView ref={log} style={styles.log} contentContainerStyle={styles.logContent} accessibilityLabel="Conversation"
      onContentSizeChange={() => log.current?.scrollToEnd({ animated: true })}>
      {voice.entries.map((entry) => entry.kind === "line"
        ? <Line key={entry.id} who={entry.line.role === "user" ? "You" : entry.line.role === "assistant" ? "DAVE" : "Note"} text={entry.line.text} user={entry.line.role === "user"} />
        : <CardView key={entry.id} card={entry.card} />)}
      {voice.caption.user !== "" && <Line who="You" text={voice.caption.user} user caption />}
      {voice.caption.assistant !== "" && <Line who="DAVE" text={voice.caption.assistant} user={false} caption />}
      {!voice.entries.length && !voice.caption.user && !voice.caption.assistant && <Muted>Tap the paperclip to share a PDF or photo with DAVE.</Muted>}
    </ScrollView>

    <View style={[styles.bottom, { paddingBottom: Math.max(insets.bottom, space.sm) }]}>
      <View style={styles.controls}>
        {active
          ? <Button title="End" icon={PhoneOff} variant="danger" onPress={() => voice.end("user")} style={styles.talk} />
          : <Button title="Talk" icon={AudioLines} variant="primary" disabled={state.phase === "ending"} onPress={voice.start} style={styles.talk} />}
        {voice.mode === "push_to_talk"
          ? <Pressable disabled={!live} onPressIn={() => voice.pushToTalk("down")} onPressOut={() => voice.pushToTalk("up")}
            accessibilityRole="button" accessibilityLabel="Hold to talk" accessibilityState={{ disabled: !live, selected: voice.holding }}
            style={[styles.round, voice.holding && styles.roundOn, !live && styles.disabled]}><Hand size={20} color={voice.holding ? colors.onAccent : colors.ink} /></Pressable>
          : <Pressable disabled={!live} onPress={voice.toggleMute} accessibilityRole="button" accessibilityLabel={voice.muted ? "Unmute microphone" : "Mute microphone"}
            accessibilityState={{ disabled: !live, selected: voice.muted }} style={[styles.round, voice.muted && styles.roundOn, !live && styles.disabled]}>
            {voice.muted ? <MicOff size={20} color={colors.onAccent} /> : <Mic size={20} color={colors.ink} />}</Pressable>}
        <IconButton icon={Paperclip} label="Share a file" onPress={share} />
        <IconButton icon={Settings} label="Voice settings" onPress={() => setSettingsOpen(true)} />
      </View>
      {!active && <Toggle label="Approve all for this session" value={voice.approveOnStart} onValueChange={voice.setApproveOnStart}
        help="DAVE makes changes without asking until this conversation ends. Only you can turn this on." />}
      <View style={styles.type}>
        <TextInput style={styles.input} accessibilityLabel="Type to DAVE" placeholder={live ? "Type to DAVE" : "Start talking to type"} placeholderTextColor={colors.control}
          editable={live} value={draft} onChangeText={setDraft} maxLength={2000} returnKeyType="send" onSubmitEditing={submit} />
        <IconButton icon={Send} label="Send message" disabled={!live || !draft.trim()} onPress={submit} color={colors.accent} />
      </View>
      {voice.status?.disclosure ? <Caption>{voice.status.disclosure}</Caption> : null}
    </View>
    <SettingsSheet visible={settingsOpen} onClose={() => setSettingsOpen(false)} />
  </KeyboardAvoidingView>;
}

async function pickPhotos(camera: boolean): Promise<PickedFile[]> {
  try {
    const permission = camera ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(camera ? "Camera access is off" : "Photo access is off", "Allow it for DAVE in Settings to share photos.", [
        { text: "Cancel", style: "cancel" }, { text: "Open Settings", onPress: () => { void Linking.openSettings(); } },
      ]);
      return [];
    }
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.7, allowsMultipleSelection: !camera };
    const result = camera ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
    if (result.canceled) return [];
    return result.assets.map((a, i) => ({ name: a.fileName ?? `photo-${i + 1}.jpg`, uri: a.uri, mimeType: a.mimeType ?? "image/jpeg", size: a.fileSize ?? null }));
  } catch (e) { Alert.alert("Could not open photos", describeError(e)); return []; }
}

async function pickDocuments(): Promise<PickedFile[]> {
  try {
    const result = await DocumentPicker.getDocumentAsync({ type: ["application/pdf", "image/*"], multiple: true, copyToCacheDirectory: true });
    if (result.canceled) return [];
    return result.assets.map((a) => ({ name: a.name, uri: a.uri, mimeType: a.mimeType ?? null, size: a.size ?? null }));
  } catch (e) { Alert.alert("Could not open files", describeError(e)); return []; }
}

function Line({ who, text: body, user, caption = false }: { who: string; text: string; user: boolean; caption?: boolean }) {
  return <View style={[styles.line, user ? styles.lineUser : styles.lineDave, caption && styles.caption]}>
    <Text style={[text.caption, styles.bold]}>{who}</Text>
    <Text style={text.body} selectable>{body}</Text>
  </View>;
}

function Card({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <View style={[styles.card, { borderLeftColor: tones[tone], backgroundColor: tints[tone] }]}>{children}</View>;
}

function CardView({ card }: { card: VoiceCard }) {
  const voice = useVoice();
  const router = useRouter();
  if (card.kind === "action") {
    const link = card.card.link?.startsWith("#") ? card.card.link : null;
    return <Card tone={card.card.tone}>
      <Small strong selectable>{card.card.title}</Small>
      {card.card.detail ? <Small selectable>{card.card.detail}</Small> : null}
      {link && <OpenLink hash={link} onOpen={(href) => router.push(href as Href)} />}
      {card.undo && (card.undo.state === "done"
        ? <Caption>Undone. The items are back.</Caption>
        : <View style={styles.actions}>
          <Button title="Undo" icon={Undo2} compact disabled={card.undo.state === "busy"} loading={card.undo.state === "busy"} accessibilityLabel={`Undo: ${card.card.title}`} onPress={() => voice.undoCleanUp(card.id)} />
          {card.undo.state === "failed" && <Text style={text.caption} accessibilityRole="alert">Undo did not go through. Try again or use Clean up.</Text>}
        </View>)}
    </Card>;
  }
  if (card.kind === "approval") return <Card tone="amber">
    <Small strong>Approve all for this session?</Small>
    <Small>DAVE makes changes without asking until this conversation ends. Only you can turn this on.</Small>
    {card.state === "on" ? <Caption>Approve all is on.</Caption>
      : <View style={styles.actions}><Button title="Approve all" icon={CheckCheck} variant="primary" compact disabled={voice.state.phase !== "live" || voice.approval.on} onPress={() => voice.setApproval(true)} /></View>}
  </Card>;
  if (card.kind === "confirm") return <Card tone="amber">
    <Small strong selectable>{card.confirm.title}</Small>
    <Small selectable>{card.confirm.say}</Small>
    {card.confirm.details.map((d, i) => <Text key={i} style={text.small} selectable>• {d}</Text>)}
    {card.state === "open" || card.state === "busy"
      ? <View style={styles.actions}>
        <Button title="Confirm" icon={Check} variant="primary" compact disabled={card.state === "busy"} loading={card.state === "busy"} onPress={() => voice.answerConfirm(card.id, true)} />
        <Button title="Not that" compact disabled={card.state === "busy"} onPress={() => voice.answerConfirm(card.id, false)} />
        <Button title="Approve all" icon={CheckCheck} compact disabled={card.state === "busy" || voice.state.phase !== "live"}
          accessibilityLabel="Approve all for this session (confirms this and every later change)" onPress={() => voice.setApproval(true)} />
      </View>
      : <Caption>{card.state === "accepted" ? "Done." : card.state === "declined" ? "Nothing was changed." : "That did not go through. Nothing was changed."}</Caption>}
  </Card>;
  if (card.kind === "copy") return <Card tone="blue">
    <Small strong>{card.copy.label}</Small>
    <ScrollView style={styles.copyBox} nestedScrollEnabled><Text style={text.mono} selectable>{card.copy.text}</Text></ScrollView>
    <View style={styles.actions}><Button title={card.state === "copied" ? "Copied and marked sent" : "Copy for EZcoder"} icon={Copy} variant="primary" compact
      disabled={card.state === "copied"} onPress={() => { tick(); voice.copyCard(card.id); }} /></View>
    {card.state === "failed" && <Caption>Could not copy or mark sent. Try again.</Caption>}
  </Card>;
  return <DocumentCard id={card.id} document={card.document} imageSent={card.imageSent} />;
}

function OpenLink({ hash, onOpen }: { hash: string; onOpen: (href: string) => void }) {
  const href = webRouteToPhoneHref(hash);
  if (!href) return null;
  return <Button title="Open" variant="subtle" compact onPress={() => onOpen(href)} />;
}

function DocumentCard({ id, document: doc, imageSent }: { id: string; document: DocumentMeta; imageSent: boolean }) {
  const voice = useVoice();
  const api = useApi();
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    if (doc.kind !== "image") return;
    const ac = new AbortController();
    void api.binary(`/api/files/${encodeURIComponent(doc.id)}/content`, { signal: ac.signal }).then((body) => { if (!ac.signal.aborted) setThumb(imageDataUri(body)); }, () => undefined);
    return () => ac.abort();
  }, [api, doc.id, doc.kind]);
  return <Card tone="violet">
    <View style={styles.doc}>
      {thumb ? <Image source={{ uri: thumb }} style={styles.thumb} accessibilityIgnoresInvertColors /> : <View style={styles.thumbIcon}><FileText size={28} color={tones.violet} /></View>}
      <View style={styles.flex}>
        <Small strong selectable>{doc.name}</Small>
        <Caption>{documentSummary(doc, imageSent)}</Caption>
        <View style={styles.actions}><Button title="Ask DAVE about it" compact disabled={voice.state.phase !== "live"} onPress={() => voice.askAbout(id)} /></View>
      </View>
    </View>
  </Card>;
}

function SettingsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const voice = useVoice();
  const api = useApi();
  const settings = voice.settings;
  const [history, setHistory] = useState<VoiceHistoryEntry[] | null>(null);
  const [memory, setMemory] = useState<VoiceMemory["notes"] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const { reloadStatus } = voice;

  useEffect(() => {
    if (!visible) return;
    const ac = new AbortController();
    setMessage(null);
    reloadStatus();
    void api.get<{ sessions: VoiceHistoryEntry[] }>("/api/voice/history", { signal: ac.signal }).then((r) => setHistory(r.sessions), () => setHistory([]));
    void api.get<VoiceMemory>("/api/voice/memory", { signal: ac.signal }).then((r) => setMemory(r.notes), () => setMemory([]));
    return () => ac.abort();
  }, [api, visible, reloadStatus]);

  const save = (patch: Parameters<typeof voice.saveSettings>[0]) => {
    setSaving(true);
    void voice.saveSettings(patch).then((m) => { setMessage(m); setSaving(false); });
  };
  const forget = (noteId: string) => {
    setForgetting(noteId);
    void api.post(`/api/intel/notes/${encodeURIComponent(noteId)}/delete`, {}).then(
      () => { setMemory((m) => m?.filter((n) => n.id !== noteId) ?? null); setForgetting(null); },
      (e: unknown) => { setMessage(describeError(e, "Could not forget that.")); setForgetting(null); });
  };

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <View style={styles.sheetHead}>
      <Text style={text.heading} accessibilityRole="header">Settings</Text>
      <IconButton icon={X} label="Close settings" onPress={onClose} />
    </View>
    <ScrollView style={styles.sheet} contentContainerStyle={styles.sheetContent}>
      {settings ? <View style={styles.form}>
        <SelectField label="Voice" value={settings.voice} disabled={saving} onChange={(v: VoiceName) => save({ voice: v })}
          options={(voice.status?.voices ?? VOICES).map((v) => ({ value: v, label: v }))} />
        <SelectField label="Model" value={settings.model} disabled={saving} onChange={(m: RealtimeModel) => save({ model: m })}
          options={(voice.status?.models ?? MODELS).map((m) => ({ value: m, label: m }))} />
        <SelectField<VoiceMode> label="Mode" value={settings.mode} disabled={saving} onChange={(m) => save({ mode: m })}
          options={[{ value: "hands_free", label: "Hands-free" }, { value: "push_to_talk", label: "Push to talk" }]} />
        <Toggle label="DAVE speaks first" value={settings.greeting} disabled={saving} onValueChange={(v) => save({ greeting: v })} />
        <Toggle label="Start and stop sounds" value={settings.sounds} disabled={saving} onValueChange={(v) => save({ sounds: v })} />
        <Caption>Changes apply to the next conversation.</Caption>
      </View> : <LoadingState label="Settings are loading…" />}
      {message && <Text style={[text.small, { color: tones.red }]} accessibilityRole="alert">{message}</Text>}
      <Divider />
      <Text style={text.subheading} accessibilityRole="header">Meet DAVE</Text>
      <MoodGallery size={64} />
      <Divider />
      <Text style={text.subheading} accessibilityRole="header">Recent conversations</Text>
      {history === null ? <Muted>Loading…</Muted> : history.length ? history.slice(0, 10).map((h) => <View key={h.id} style={styles.listItem}>
        <Small strong>{new Date(h.startedAt).toLocaleString()}{h.projectName ? ` · ${h.projectName}` : ""}</Small>
        <Text style={text.small} selectable>{historySummary(h)}</Text>
      </View>) : <Muted>No conversations yet.</Muted>}
      <Divider />
      <Text style={text.subheading} accessibilityRole="header">What DAVE remembers</Text>
      {memory === null ? <Muted>Loading…</Muted> : memory.length ? memory.map((n) => <View key={n.id} style={[styles.listItem, styles.memory]}>
        <Text style={[text.small, styles.flex]} selectable>{n.projectName ? `${n.projectName}: ` : ""}{n.text}</Text>
        <Button title="Forget" variant="danger-subtle" compact loading={forgetting === n.id} disabled={forgetting !== null} accessibilityLabel={`Forget: ${n.text.slice(0, 60)}`} onPress={() => forget(n.id)} />
      </View>) : <EmptyState title="Nothing yet" message="Tell DAVE what matters and it will remember." />}
      <BottomSpacer />
    </ScrollView>
  </Modal>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  flex: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  top: { padding: space.lg, paddingBottom: space.sm, gap: space.sm, backgroundColor: colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  hero: { flexDirection: "row", alignItems: "center", gap: space.md },
  heroText: { flex: 1, gap: space.xs, alignItems: "flex-start" },
  approval: { flexDirection: "row", alignItems: "center", gap: space.sm, borderLeftWidth: 3, borderRadius: radius.md, padding: space.sm },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  chip: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: space.xxs, backgroundColor: colors.surface },
  log: { flex: 1 },
  logContent: { padding: space.lg, gap: space.sm },
  line: { gap: space.xxs, padding: space.sm, borderRadius: radius.md, maxWidth: "92%" },
  lineUser: { alignSelf: "flex-end", backgroundColor: colors.wash },
  lineDave: { alignSelf: "flex-start", backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  caption: { opacity: 0.7 },
  card: { borderLeftWidth: 3, borderRadius: radius.md, padding: space.md, gap: space.xs },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center", marginTop: space.xs },
  copyBox: { maxHeight: 180, backgroundColor: colors.surface, borderRadius: radius.sm, padding: space.sm },
  doc: { flexDirection: "row", gap: space.md, alignItems: "flex-start" },
  thumb: { width: 64, height: 64, borderRadius: radius.sm, backgroundColor: colors.sunken },
  thumbIcon: { width: 64, height: 64, borderRadius: radius.sm, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
  bottom: { padding: space.lg, paddingTop: space.sm, gap: space.sm, backgroundColor: colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  controls: { flexDirection: "row", alignItems: "center", gap: space.sm },
  talk: { flex: 1 },
  round: { width: touch, height: touch, borderRadius: touch / 2, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
  roundOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  disabled: { opacity: 0.45 },
  type: { flexDirection: "row", alignItems: "center", gap: space.xs },
  input: { flex: 1, minHeight: touch, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: space.md, fontSize: 16, color: colors.ink, backgroundColor: colors.surface },
  sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.lg, paddingTop: space.md, backgroundColor: colors.surface },
  sheet: { flex: 1, backgroundColor: colors.surface },
  sheetContent: { padding: space.lg, gap: space.md },
  form: { gap: space.md },
  listItem: { gap: space.xxs, paddingVertical: space.xs },
  memory: { flexDirection: "row", alignItems: "center", gap: space.sm },
});
