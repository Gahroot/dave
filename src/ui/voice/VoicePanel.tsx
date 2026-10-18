import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from "react";
import { AudioLines, Check, CheckCheck, Undo2, ShieldCheck, Copy, FileText, Hand, Mic, MicOff, Paperclip, PhoneOff, Send, Settings, X } from "lucide-react";
import { DaveMascot } from "../mascot/DaveMascot.tsx";
import { LedText } from "../mascot/LedText.tsx";
import { MoodGallery } from "../mascot/MoodGallery.tsx";
import { MOOD_LABEL } from "../mascot/types.ts";
import { MODELS, VOICES, type DocumentMeta, type RealtimeModel, type VoiceHistoryEntry, type VoiceMemory, type VoiceMode, type VoiceName } from "../../voice/types.ts";
import { voiceApi } from "./api.ts";
import { isActive, mascotMood, voiceStatusLabel } from "./machine.ts";
import { approvalAnnouncement, type VoiceCard } from "./model.ts";
import { useVoice } from "./VoiceProvider.tsx";
import "./voice.css";

export type VoicePanelProps = { variant: "drawer" | "page" };

export function VoicePanel({ variant }: VoicePanelProps) {
  const voice = useVoice();
  const { state } = voice;
  const root = useRef<HTMLElement>(null);
  const logEnd = useRef<HTMLLIElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const active = isActive(state);
  const live = state.phase === "live";
  const mood = mascotMood(state);

  useEffect(() => { if (variant === "drawer") root.current?.focus(); }, [variant]);
  // Undo, Turn off and Approve all swap to plain text once used, and End is disabled while the call closes. If the
  // control that had focus is gone or disabled, keep focus in the panel (not the page body), so the keyboard and
  // Escape keep working.
  const lastFocus = useRef<HTMLElement | null>(null);
  const refocus = useRef(0);
  useEffect(() => () => window.clearTimeout(refocus.current), []);
  useEffect(() => {
    const el = lastFocus.current;
    if (!el || (el.isConnected && !el.matches(":disabled"))) return;
    lastFocus.current = null;
    // The browser moves focus off a removed or disabled control in its own later step, so check just after it.
    window.clearTimeout(refocus.current);
    refocus.current = window.setTimeout(() => {
      if (document.activeElement === null || document.activeElement === document.body) root.current?.focus({ preventScroll: true });
    }, 50);
  });
  useEffect(() => { logEnd.current?.scrollIntoView?.({ block: "end" }); }, [voice.entries.length, voice.caption.assistant, voice.caption.user]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (settingsOpen) { setSettingsOpen(false); event.stopPropagation(); return; }
    if (variant === "drawer") { event.stopPropagation(); voice.closePanel(); }
  };
  const share = (files: FileList | null | undefined) => { if (files?.length) voice.shareFiles([...files]); };
  const onDrop = (event: DragEvent) => { event.preventDefault(); setDragging(false); share(event.dataTransfer.files); };
  const onPaste = (event: ClipboardEvent) => { if (event.clipboardData.files.length) { event.preventDefault(); share(event.clipboardData.files); } };
  const submit = (event: FormEvent) => { event.preventDefault(); if (!text.trim() || !live) return; voice.sendText(text, { fromUser: true }); setText(""); };

  const detail = voice.error ? voice.error.message
    : state.phase === "idle" || state.phase === "ended" ? (voice.status?.availability.state === "unavailable" ? voice.status.availability.message : state.phase === "ended" ? "Conversation saved. Talk again any time." : "Press Talk and say what matters most this week.")
    : `DAVE is ${MOOD_LABEL[mood]}.`;

  return <section ref={root} tabIndex={-1} data-voice-panel className={`voice-stage voice-${variant}${dragging ? " voice-dragging" : ""}`}
    role={variant === "drawer" ? "dialog" : "region"} aria-label="Talk to DAVE" onKeyDown={onKeyDown} onFocus={e => { if (e.target instanceof HTMLElement) lastFocus.current = e.target; }}
    onDragOver={e => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }} onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false); }} onDrop={onDrop} onPaste={onPaste}>
    <header className="voice-top">
      <div className="voice-topbar">
        <span className="voice-title">Talk to DAVE</span>
        {variant === "drawer" && <button type="button" className="voice-icon-button" aria-label="Close voice panel (conversation keeps going)" onClick={voice.closePanel}><X size={20} aria-hidden="true" /></button>}
      </div>
      <DaveMascot mood={mood} size={180} levels={voice.levels} className="voice-hero" />
      <LedText text={voiceStatusLabel(state)} tone={state.phase === "error" ? "oops" : active ? "lit" : "dim"} className="voice-led" />
      <p className="voice-detail">{detail}{voice.error?.connect && <> <a href="#connections">Open Connections</a></>}</p>
      {live && voice.approval.on && <div className="voice-approval-banner" role="note">
        <ShieldCheck size={16} aria-hidden="true" /><span>{approvalAnnouncement(true)}</span>
        <button type="button" className="voice-button" onClick={() => voice.setApproval(false)} aria-label="Turn off Approve all">Turn off</button>
      </div>}
      <ul className="voice-chips" aria-label="What DAVE sees">
        {voice.chips.decisions > 0 && <li className="voice-chip voice-chip-amber">{voice.chips.decisions} decision{voice.chips.decisions === 1 ? "" : "s"} waiting</li>}
        {voice.chips.noFinishLine > 0 && <li className="voice-chip">{voice.chips.noFinishLine} without a finish line</li>}
        {voice.lookingAt && <li className="voice-chip voice-chip-violet">Looking at: {voice.lookingAt}</li>}
      </ul>
    </header>

    <ol className="voice-log" role="log" aria-live="off" aria-label="Conversation">
      {voice.entries.map(entry => entry.kind === "line"
        ? <li key={entry.id} className={`voice-line voice-line-${entry.line.role}`}><span className="voice-who">{entry.line.role === "user" ? "You" : entry.line.role === "assistant" ? "DAVE" : "Note"}</span>{entry.line.text}</li>
        : <li key={entry.id}><CardView card={entry.card} /></li>)}
      {voice.caption.user && <li className="voice-line voice-line-user voice-caption"><span className="voice-who">You</span>{voice.caption.user}</li>}
      {voice.caption.assistant && <li className="voice-line voice-line-assistant voice-caption"><span className="voice-who">DAVE</span>{voice.caption.assistant}</li>}
      {!voice.entries.length && !voice.caption.user && !voice.caption.assistant && <li className="voice-empty">Drop or paste a file here to share it with DAVE.</li>}
      <li ref={logEnd} aria-hidden="true" className="voice-log-end" />
    </ol>

    <footer className="voice-bottom">
      <div className="voice-controls">
        {active
          ? <button type="button" className="voice-pill voice-pill-end" onClick={() => voice.end("user")}><PhoneOff size={18} aria-hidden="true" />End</button>
          : <button type="button" className="voice-pill" disabled={state.phase === "ending"} onClick={voice.start}><AudioLines size={18} aria-hidden="true" />Talk</button>}
        {voice.mode === "push_to_talk"
          ? <button type="button" className={`voice-round${voice.holding ? " voice-on" : ""}`} disabled={!live} aria-pressed={voice.holding} aria-label="Hold to talk (or hold Space)"
            onPointerDown={() => voice.pushToTalk("down")} onPointerUp={() => voice.pushToTalk("up")} onPointerLeave={() => { if (voice.holding) voice.pushToTalk("up"); }}><Hand size={20} aria-hidden="true" /></button>
          : <button type="button" className={`voice-round${voice.muted ? " voice-on" : ""}`} disabled={!live} aria-pressed={voice.muted} aria-label={voice.muted ? "Unmute microphone" : "Mute microphone"} onClick={voice.toggleMute}>{voice.muted ? <MicOff size={20} aria-hidden="true" /> : <Mic size={20} aria-hidden="true" />}</button>}
        {!active && <label className="voice-check voice-approve-toggle"><input type="checkbox" checked={voice.approveOnStart} onChange={e => voice.setApproveOnStart(e.target.checked)} />Approve all for this session</label>}
        <button type="button" className="voice-round" aria-label="Share a file" onClick={() => fileInput.current?.click()}><Paperclip size={20} aria-hidden="true" /></button>
        <input ref={fileInput} type="file" multiple hidden onChange={e => { share(e.currentTarget.files); e.currentTarget.value = ""; }} />
        <button type="button" className="voice-round" aria-label="Voice settings" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(v => !v)}><Settings size={20} aria-hidden="true" /></button>
      </div>
      <form className="voice-type" onSubmit={submit}>
        <input aria-label="Type to DAVE" placeholder={live ? "Type to DAVE" : "Start talking to type"} disabled={!live} value={text} onChange={e => setText(e.target.value)} maxLength={2000} />
        <button type="submit" className="voice-round" aria-label="Send message" disabled={!live || !text.trim()}><Send size={18} aria-hidden="true" /></button>
      </form>
      {voice.status?.disclosure && <p className="voice-disclosure">{voice.status.disclosure}</p>}
    </footer>
    {settingsOpen && <SettingsSheet onClose={() => setSettingsOpen(false)} />}
  </section>;
}

function CardView({ card }: { card: VoiceCard }) {
  const voice = useVoice();
  if (card.kind === "action") return <div className={`voice-card voice-tone-${card.card.tone}`}>
    <strong>{card.card.title}</strong>{card.card.detail && <p>{card.card.detail}</p>}{card.card.link?.startsWith("#") && <a href={card.card.link}>Open</a>}
    {card.undo && (card.undo.state === "done"
      ? <p className="voice-card-state">Undone. The items are back.</p>
      : <div className="voice-card-actions"><button type="button" className="voice-button" disabled={card.undo.state === "busy"} aria-label={`Undo: ${card.card.title}`} onClick={() => voice.undoCleanUp(card.id)}><Undo2 size={16} aria-hidden="true" />Undo</button>
        {card.undo.state === "failed" && <span className="voice-card-state" role="alert">Undo did not go through. Try again or use Clean up.</span>}</div>)}
  </div>;
  if (card.kind === "approval") return <div className="voice-card voice-tone-amber">
    <strong>Approve all for this session?</strong><p>DAVE makes changes without asking until this conversation ends. Only you can turn this on.</p>
    {card.state === "on" ? <p className="voice-card-state">Approve all is on.</p>
      : <div className="voice-card-actions"><button type="button" className="voice-button voice-button-primary" disabled={voice.state.phase !== "live" || voice.approval.on} onClick={() => voice.setApproval(true)}><CheckCheck size={16} aria-hidden="true" />Approve all</button></div>}
  </div>;
  if (card.kind === "confirm") return <div className="voice-card voice-tone-amber">
    <strong>{card.confirm.title}</strong><p>{card.confirm.say}</p>
    {card.confirm.details.length > 0 && <ul>{card.confirm.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}
    {card.state === "open" || card.state === "busy"
      ? <div className="voice-card-actions"><button type="button" className="voice-button voice-button-primary" disabled={card.state === "busy"} onClick={() => voice.answerConfirm(card.id, true)}><Check size={16} aria-hidden="true" />Confirm</button><button type="button" className="voice-button" disabled={card.state === "busy"} onClick={() => voice.answerConfirm(card.id, false)}>Not that</button><button type="button" className="voice-button" disabled={card.state === "busy" || voice.state.phase !== "live"} aria-label="Approve all for this session (confirms this and every later change)" onClick={() => voice.setApproval(true)}><CheckCheck size={16} aria-hidden="true" />Approve all</button></div>
      : <p className="voice-card-state">{card.state === "accepted" ? "Done." : card.state === "declined" ? "Nothing was changed." : "That did not go through. Nothing was changed."}</p>}
  </div>;
  if (card.kind === "copy") return <div className="voice-card voice-tone-blue">
    <strong>{card.copy.label}</strong><pre className="voice-copy-text">{card.copy.text}</pre>
    <div className="voice-card-actions"><button type="button" className="voice-button voice-button-primary" disabled={card.state === "copied"} onClick={() => voice.copyCard(card.id)}><Copy size={16} aria-hidden="true" />{card.state === "copied" ? "Copied and marked sent" : "Copy for EZcoder"}</button></div>
    {card.state === "failed" && <p className="voice-card-state">Could not copy or mark sent. Try again.</p>}
  </div>;
  return <DocumentCard id={card.id} document={card.document} imageSent={card.imageSent} />;
}

function DocumentCard({ id, document: doc, imageSent }: { id: string; document: DocumentMeta; imageSent: boolean }) {
  const voice = useVoice();
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    if (doc.kind !== "image") return;
    const ac = new AbortController();
    let url: string | null = null;
    void voiceApi.content(doc.id, ac.signal).then(blob => { if (!ac.signal.aborted) { url = URL.createObjectURL(blob); setThumb(url); } }, () => undefined);
    return () => { ac.abort(); if (url) URL.revokeObjectURL(url); };
  }, [doc.id, doc.kind]);
  return <div className="voice-card voice-tone-violet voice-doc">
    {thumb ? <img src={thumb} alt="" className="voice-thumb" /> : <FileText size={36} aria-hidden="true" className="voice-thumb-icon" />}
    <div>
      <strong>{doc.name}</strong>
      <p>{[doc.kind.toUpperCase(), doc.pages ? `${doc.pages} page${doc.pages === 1 ? "" : "s"}` : null, doc.textState === "ready" ? "text read" : doc.textState === "pending" ? "reading text…" : "no text", imageSent ? "image sent" : null].filter(Boolean).join(" · ")}</p>
      <button type="button" className="voice-button" disabled={voice.state.phase !== "live"} onClick={() => voice.askAbout(id)}>Ask DAVE about it</button>
    </div>
  </div>;
}

function SettingsSheet({ onClose }: { onClose: () => void }) {
  const voice = useVoice();
  const settings = voice.settings;
  const [history, setHistory] = useState<VoiceHistoryEntry[] | null>(null);
  const [memory, setMemory] = useState<VoiceMemory["notes"] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    sheet.current?.focus();
    const ac = new AbortController();
    void voiceApi.history(ac.signal).then(r => setHistory(r.sessions), () => setHistory([]));
    void voiceApi.memory(ac.signal).then(r => setMemory(r.notes), () => setMemory([]));
    return () => ac.abort();
  }, []);
  const save = (patch: Parameters<typeof voice.saveSettings>[0]) => { void voice.saveSettings(patch).then(setMessage); };
  const forget = (id: string) => { void voiceApi.deleteNote(id).then(() => setMemory(m => m?.filter(n => n.id !== id) ?? null), (e: unknown) => setMessage(e instanceof Error ? e.message : "Could not forget that.")); };

  return <div ref={sheet} tabIndex={-1} className="voice-sheet" role="group" aria-label="Voice settings">
    <div className="voice-topbar"><span className="voice-title">Settings</span><button type="button" className="voice-icon-button" aria-label="Close settings" onClick={onClose}><X size={20} aria-hidden="true" /></button></div>
    {settings ? <div className="voice-form">
      <label>Voice<select value={settings.voice} onChange={e => save({ voice: e.target.value as VoiceName })}>{(voice.status?.voices ?? VOICES).map(v => <option key={v} value={v}>{v}</option>)}</select></label>
      <label>Model<select value={settings.model} onChange={e => save({ model: e.target.value as RealtimeModel })}>{(voice.status?.models ?? MODELS).map(m => <option key={m} value={m}>{m}</option>)}</select></label>
      <label>Mode<select value={settings.mode} onChange={e => save({ mode: e.target.value as VoiceMode })}><option value="hands_free">Hands-free</option><option value="push_to_talk">Push to talk</option></select></label>
      <label className="voice-check"><input type="checkbox" checked={settings.greeting} onChange={e => save({ greeting: e.target.checked })} />DAVE speaks first</label>
      <label className="voice-check"><input type="checkbox" checked={settings.sounds} onChange={e => save({ sounds: e.target.checked })} />Start and stop sounds</label>
      <p className="voice-hint">Changes apply to the next conversation.</p>
    </div> : <p>Settings are loading…</p>}
    {message && <p className="voice-card-state" role="alert">{message}</p>}
    <h3>Meet DAVE</h3>
    <MoodGallery size={64} />
    <h3>Recent conversations</h3>
    {history === null ? <p>Loading…</p> : history.length ? <ul className="voice-list">{history.slice(0, 10).map(h => <li key={h.id}><strong>{new Date(h.startedAt).toLocaleString()}</strong>{h.projectName ? ` · ${h.projectName}` : ""}<br />{h.summary ?? `${h.lines} lines, ${h.actions} actions`}</li>)}</ul> : <p>No conversations yet.</p>}
    <h3>What DAVE remembers</h3>
    {memory === null ? <p>Loading…</p> : memory.length ? <ul className="voice-list">{memory.map(n => <li key={n.id}><span>{n.projectName ? `${n.projectName}: ` : ""}{n.text}</span><button type="button" className="voice-button" aria-label={`Forget: ${n.text.slice(0, 60)}`} onClick={() => forget(n.id)}>Forget</button></li>)}</ul> : <p>Nothing yet. Tell DAVE what matters and it will remember.</p>}
  </div>;
}
