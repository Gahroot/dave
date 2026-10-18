import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import type { FocusState } from "../../intel/types.ts";
import { intelApi } from "../intel-api.ts";
import { triageApi } from "../triage-api.ts";
import type { DaveLevels } from "../mascot/types.ts";
import { DATA_CHANGED_EVENT, LIMITS, type DataChangedDetail, type EndReason, type StartSessionResponse, type ApprovalVia, type ToolCallResponse, type VoiceMode, type VoiceSettings, type VoiceStatus } from "../../voice/types.ts";
import { voiceApi, VoiceRequestError } from "./api.ts";
import { INITIAL_VOICE_STATE, isActive, phaseAnnouncement, voiceReducer, type VoiceState } from "./machine.ts";
import { appendCard, appendLine, approvalAnnouncement, approvalNote, cardsFromToolResponse, confirmNote, openConfirmIds, UNDO_NOTE, undoState, USER_WORDS_WAIT_MS, contextNote, documentTextNote, downscalePlan, focusChips, focusUpdateNote, imageSendable, isTypingTarget, matchShortcut, pageContext, sharedNote, transcriptOf, updateCard, type FocusChips, type TimelineEntry, type VoiceCard } from "./model.ts";
import { createRealtimeSession, type RealtimeSession } from "./realtime-session.ts";
import { playChime } from "./sounds.ts";
import { browserTransportDeps, connectTransport, TransportError, type Transport } from "./transport.ts";

const FOCUS_POLL_MS = 90_000;
const IDLE_END_MS = 5 * 60_000;
/** Server-side text extraction is capped at 30 s per file; follow it a little longer than that. */
const DOC_POLL_MS = 1_000;
const DOC_POLL_TRIES = 45;

export type VoiceError = { message: string; connect: boolean };
export type VoiceContextValue = {
  state: VoiceState;
  entries: TimelineEntry[];
  caption: { user: string; assistant: string };
  status: VoiceStatus | null;
  settings: VoiceSettings | null;
  mode: VoiceMode;
  muted: boolean;
  holding: boolean;
  error: VoiceError | null;
  chips: FocusChips;
  lookingAt: string | null;
  levels: DaveLevels;
  open: boolean;
  openPanel: () => void;
  closePanel: () => void;
  start: () => void;
  end: (reason?: EndReason) => void;
  toggleMute: () => void;
  pushToTalk: (edge: "down" | "up") => void;
  /** fromUser: typed by the user in the panel (counts as the user's own words for approve_session). */
  sendText: (text: string, options?: { fromUser?: boolean }) => void;
  approval: { on: boolean; via: ApprovalVia | null };
  setApproval: (on: boolean) => void;
  undoCleanUp: (cardId: string) => void;
  shareFiles: (files: readonly File[]) => void;
  answerConfirm: (cardId: string, accept: boolean) => void;
  copyCard: (cardId: string) => void;
  askAbout: (cardId: string) => void;
  saveSettings: (patch: Partial<VoiceSettings>) => Promise<string | null>;
};

const VoiceContext = createContext<VoiceContextValue | null>(null);

export function useVoice(): VoiceContextValue {
  const value = useContext(VoiceContext);
  if (!value) throw new Error("useVoice must be used inside VoiceProvider");
  return value;
}

type Live = {
  sessionId: string; session: RealtimeSession; transport: Transport | null; mode: VoiceMode; abort: AbortController; endAfterSpeech: boolean; modelSpeaking: boolean;
  /** The user's own most recent words (their transcripts and typed text; never app notes or generated messages). */
  lastUserWords: string;
  /** Speech stopped but its transcript has not arrived yet; waiters resume when it does. */
  transcriptPending: boolean;
  transcriptWaiters: (() => void)[];
};
function releaseWaiters(current: Live): void {
  current.transcriptPending = false;
  for (const resume of current.transcriptWaiters.splice(0)) resume();
}
/** Resolves at once unless a user transcript is on its way; then when it lands, or after USER_WORDS_WAIT_MS. */
function waitForTranscript(current: Live): Promise<void> {
  if (!current.transcriptPending) return Promise.resolve();
  return new Promise(resolve => {
    const timer = window.setTimeout(() => { current.transcriptWaiters = current.transcriptWaiters.filter(w => w !== done); resolve(); }, USER_WORDS_WAIT_MS);
    const done = () => { window.clearTimeout(timer); resolve(); };
    current.transcriptWaiters.push(done);
  });
}
const ZERO_LEVELS: DaveLevels = { input: () => 0, output: () => 0 };
const nowIso = () => new Date().toISOString();

async function imageDataUrl(file: File): Promise<string | null> {
  if (!file.type.startsWith("image/") || typeof createImageBitmap === "undefined") return null;
  try {
    const bitmap = await createImageBitmap(file);
    const plan = downscalePlan(bitmap.width, bitmap.height);
    if (!plan) return null;
    const canvas = document.createElement("canvas");
    canvas.width = plan.width; canvas.height = plan.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, plan.width, plan.height);
    bitmap.close();
    const url = canvas.toDataURL(plan.type, plan.quality);
    return imageSendable(url) ? url : null;
  } catch { return null; }
}

export function VoiceProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(voiceReducer, INITIAL_VOICE_STATE);
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [caption, setCaption] = useState({ user: "", assistant: "" });
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [muted, setMuted] = useState(false);
  const [holding, setHolding] = useState(false);
  const [error, setError] = useState<VoiceError | null>(null);
  const [focus, setFocus] = useState<FocusState | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<VoiceMode>("hands_free");
  const [levels, setLevels] = useState<DaveLevels>(ZERO_LEVELS);
  const [approval, setApprovalState] = useState<{ on: boolean; via: ApprovalVia | null }>({ on: false, via: null });
  const [approvalSaid, setApprovalSaid] = useState("");
  // The provider sits above the routed workspace, so it follows the hash itself for the "Looking at" chip.
  const [hash, setHash] = useState(() => typeof window === "undefined" ? "" : window.location.hash);
  const live = useRef<Live | null>(null);
  const unmounted = useRef(new AbortController());
  const entriesRef = useRef<TimelineEntry[]>([]);
  const focusRef = useRef<FocusState | null>(null);
  const lastSpeech = useRef(Date.now());
  const seq = useRef(0);
  const opener = useRef<HTMLElement | null>(null);
  const statusRef = useRef<VoiceStatus | null>(null);
  statusRef.current = status;
  const nextId = useCallback(() => `v${++seq.current}`, []);
  const sounds = () => statusRef.current?.settings.sounds ?? true;

  const mutate = useCallback((fn: (e: TimelineEntry[]) => TimelineEntry[]) => {
    setEntries(prev => { const next = fn(prev); entriesRef.current = next; return next; });
  }, []);
  const addLine = useCallback((role: "user" | "assistant" | "system", text: string) => mutate(e => appendLine(e, role, text, nowIso(), nextId())), [mutate, nextId]);
  const addCard = useCallback((card: VoiceCard) => mutate(e => appendCard(e, card)), [mutate]);

  useEffect(() => {
    const ac = new AbortController();
    void voiceApi.status(ac.signal).then(setStatus, () => undefined);
    return () => ac.abort();
  }, []);

  const end = useCallback((reason: EndReason = "user") => {
    const current = live.current;
    dispatch({ type: "end", reason });
    if (!current) return;
    live.current = null;
    current.session.close();
    current.transport?.close();
    current.abort.abort();
    releaseWaiters(current);
    setApprovalState({ on: false, via: null });
    setLevels(ZERO_LEVELS);
    setCaption({ user: "", assistant: "" });
    setHolding(false);
    playChime("stop", sounds());
    void voiceApi.end(current.sessionId, { reason, transcript: transcriptOf(entriesRef.current) })
      .catch(() => undefined)
      .finally(() => dispatch({ type: "ended" }));
  }, []);

  const fail = useCallback((code: string, message: string, connect = false) => {
    setError({ message, connect });
    const current = live.current;
    if (current) {
      live.current = null;
      current.session.close(); current.transport?.close(); current.abort.abort();
      releaseWaiters(current);
      setLevels(ZERO_LEVELS);
      void voiceApi.end(current.sessionId, { reason: code === "session_expired" ? "expired" : code === "closed" ? "closed" : "error", transcript: transcriptOf(entriesRef.current) }).catch(() => undefined);
    }
    setApprovalState({ on: false, via: null });
    dispatch({ type: "fail", code, message });
  }, []);

  const handleUi = useCallback((response: ToolCallResponse) => {
    const ui = response.ui;
    if (ui?.navigate?.startsWith("#")) window.location.hash = ui.navigate;
    if (ui?.refresh?.length) window.dispatchEvent(new CustomEvent<DataChangedDetail>(DATA_CHANGED_EVENT, { detail: { scopes: ui.refresh } }));
  }, []);

  const runTool = useCallback((current: Live, callId: string, name: string, args: Record<string, unknown>) => {
    dispatch({ type: "tool", delta: 1 });
    // Only approve_session carries the user's words; wait briefly for a transcript still on its way.
    const request = name === "approve_session"
      ? waitForTranscript(current).then(() => ({ callId, name, args, ...(current.lastUserWords ? { userWords: current.lastUserWords } : {}) }))
      : Promise.resolve({ callId, name, args });
    void request.then(body => voiceApi.tool(current.sessionId, body, current.abort.signal)).then(response => {
      if (live.current !== current) return;
      if (name === "approve_session" && response.ok && typeof args.on === "boolean") {
        const on = args.on;
        setApprovalState({ on, via: on ? "voice" : null });
        setApprovalSaid(approvalAnnouncement(on));
      }
      current.session.submitResult(callId, response.output);
      for (const card of cardsFromToolResponse(callId, response)) addCard(card);
      handleUi(response);
      if (response.endSession) {
        current.endAfterSpeech = true;
        window.setTimeout(() => { if (live.current === current) end("assistant"); }, 10_000);
      }
    }, (e: unknown) => {
      if (live.current !== current) return;
      current.session.submitResult(callId, JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "The tool failed." }));
    }).finally(() => dispatch({ type: "tool", delta: -1 }));
  }, [addCard, end, handleUi]);

  const answerRef = useRef<(cardId: string, accept: boolean) => void>(() => undefined);
  const applyApproval = useCallback((current: Live, on: boolean) => {
    void voiceApi.approval(current.sessionId, { on }, current.abort.signal).then(state => {
      if (live.current !== current) return;
      setApprovalState({ on: state.on, via: state.via });
      setApprovalSaid(approvalAnnouncement(state.on));
      current.session.notify(approvalNote(state.on));
      if (!state.on) return;
      mutate(e => e.map(x => x.kind === "card" && x.card.kind === "approval" ? { ...x, card: { ...x.card, state: "on" } } : x));
      for (const id of openConfirmIds(entriesRef.current)) answerRef.current(id, true);
    }, (e: unknown) => {
      if (live.current !== current) return;
      addCard({ kind: "action", id: `approval:${nextId()}`, card: { tone: "red", title: "Approve all did not switch", detail: e instanceof Error ? e.message : "Try again." } });
    });
  }, [addCard, mutate, nextId]);

  const start = useCallback(() => {
    if (live.current) return;
    const deps = browserTransportDeps();
    if (!deps) { setError({ message: "This browser cannot do voice (no microphone or WebRTC support).", connect: false }); dispatch({ type: "start" }); dispatch({ type: "fail", code: "unsupported", message: "Voice is not supported here." }); return; }
    setError(null);
    setCaption({ user: "", assistant: "" });
    mutate(() => []);
    dispatch({ type: "start" });
    const abort = new AbortController();
    const context = pageContext(window.location.hash);
    void (async () => {
      let started: StartSessionResponse;
      try { started = await voiceApi.start({ context }, abort.signal); }
      catch (e) {
        const message = e instanceof Error ? e.message : "Voice could not start.";
        const connect = e instanceof VoiceRequestError && (e.reason === "not_connected" || e.reason === "reconnect" || e.reason === "not_entitled");
        setError({ message, connect }); dispatch({ type: "fail", code: e instanceof VoiceRequestError && e.reason ? e.reason : "start_failed", message });
        return;
      }
      dispatch({ type: "connecting" });
      setMode(started.mode);
      let transportRef: Transport | null = null;
      const handlers: ((event: unknown) => void)[] = [];
      const channel = {
        send: (event: Record<string, unknown>) => transportRef?.channel.send(event),
        onMessage: (handler: (event: unknown) => void) => { handlers.push(handler); },
      };
      const current: Live = {
        sessionId: started.sessionId, mode: started.mode, abort, transport: null, endAfterSpeech: false, modelSpeaking: false,
        lastUserWords: "", transcriptPending: false, transcriptWaiters: [],
        session: createRealtimeSession(channel, {
          session: started.session, greeting: started.greeting,
          events: {
            onReady: () => {
              if (live.current !== current) return;
              dispatch({ type: "ready" }); lastSpeech.current = Date.now(); playChime("start", sounds());
            },
            onFunctionCall: call => { if (live.current === current) runTool(current, call.callId, call.name, call.args); },
            onCaption: (role, text) => setCaption(c => ({ ...c, [role]: text })),
            onTranscript: (role, text) => {
              addLine(role, text);
              if (role !== "user") return;
              lastSpeech.current = Date.now();
              current.lastUserWords = text.slice(-LIMITS.userWordsChars);
              releaseWaiters(current);
            },
            onModelSpeaking: speaking => {
              current.modelSpeaking = speaking;
              dispatch({ type: "model_speaking", speaking });
              if (speaking) lastSpeech.current = Date.now();
              else if (current.endAfterSpeech && live.current === current) end("assistant");
            },
            onUserSpeech: speaking => {
              dispatch({ type: "user_speech", speaking }); lastSpeech.current = Date.now();
              if (!speaking) current.transcriptPending = true;
            },
            onResponseActive: active => dispatch({ type: "response", active }),
            onFatal: (code) => {
              if (live.current !== current) return;
              const plain = code === "session_expired" ? "The voice session expired. Start again to keep talking." : code === "closed" ? "The voice connection closed. Start again to keep talking." : "OpenAI stopped the voice session. Check Connections, then start again.";
              fail(code, plain, code === "invalid_api_key");
            },
          },
        }),
      };
      live.current = current;
      try {
        transportRef = await connectTransport(deps, {
          secret: started.secret, signal: abort.signal, gated: started.mode === "push_to_talk",
          onOpen: () => { if (live.current === current) current.session.open(); },
          onClose: () => { if (live.current === current) current.session.handleClose(); },
        });
        transportRef.channel.onMessage(event => { for (const h of handlers) h(event); });
      } catch (e) {
        if (live.current !== current) return;
        fail(e instanceof TransportError ? e.code : "connect_failed", e instanceof Error ? e.message : "Could not connect voice.");
        return;
      }
      if (live.current !== current) { transportRef.close(); return; }
      current.transport = transportRef;
      transportRef.setMuted(false);
      setMuted(false);
      setLevels(transportRef.levels);
    })();
  }, [addLine, applyApproval, end, fail, mutate, runTool]);

  // Unmount: hang up.
  // Re-armed on every mount, so StrictMode's simulated unmount cannot leave it aborted.
  useEffect(() => { const ac = new AbortController(); unmounted.current = ac; return () => ac.abort(); }, []);
  useEffect(() => () => { const current = live.current; if (current) { live.current = null; current.session.close(); current.transport?.close(); current.abort.abort(); } }, []);

  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const phase = state.phase;
  // Page changes tell the model where the user is.
  useEffect(() => {
    if (phase !== "live") return;
    const onHash = () => {
      const ctx = pageContext(window.location.hash);
      const name = ctx.projectId ? focusRef.current?.projects.find(p => p.projectId === ctx.projectId)?.projectName ?? null : null;
      live.current?.session.notify(contextNote(ctx, name));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [phase]);

  // Live updates from the focus queue.
  useEffect(() => {
    if (phase !== "live") return;
    const ac = new AbortController();
    const poll = () => {
      void intelApi.focus(ac.signal).then(next => {
        const note = focusUpdateNote(focusRef.current, next);
        focusRef.current = next;
        setFocus(next);
        if (note) live.current?.session.notify(note);
      }, () => undefined);
    };
    poll();
    const timer = window.setInterval(poll, FOCUS_POLL_MS);
    // A clean-up or a decision changes the counts now; don't wait for the next poll.
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<DataChangedDetail | undefined>).detail;
      if (detail?.scopes.some(s => s === "intel" || s === "meetings")) poll();
    };
    window.addEventListener(DATA_CHANGED_EVENT, onChanged);
    return () => { ac.abort(); window.clearInterval(timer); window.removeEventListener(DATA_CHANGED_EVENT, onChanged); };
  }, [phase]);

  // Idle auto-end in hands-free mode.
  useEffect(() => {
    if (phase !== "live" || mode !== "hands_free") return;
    const timer = window.setInterval(() => {
      if (live.current && !live.current.modelSpeaking && Date.now() - lastSpeech.current > IDLE_END_MS) end("idle");
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [phase, mode, end]);

  const openPanel = useCallback(() => {
    if (document.activeElement instanceof HTMLElement && !document.activeElement.closest("[data-voice-panel]")) opener.current = document.activeElement;
    setOpen(true);
  }, []);
  const closePanel = useCallback(() => {
    setOpen(false);
    const back = opener.current;
    opener.current = null;
    window.setTimeout(() => { if (back?.isConnected) back.focus(); }, 0);
  }, []);

  const pushToTalk = useCallback((edge: "down" | "up") => {
    const current = live.current;
    if (!current?.transport || current.mode !== "push_to_talk") return;
    current.transport.setGateOpen(edge === "down");
    current.session.pushToTalk(edge);
    setHolding(edge === "down");
    lastSpeech.current = Date.now();
  }, []);

  // Alt+Shift+D toggles the panel; Space holds to talk while the panel has focus.
  useEffect(() => {
    const held = { current: false };
    const onKey = (event: KeyboardEvent) => {
      const panelFocused = !!(document.activeElement && document.activeElement.closest("[data-voice-panel]"));
      const typing = isTypingTarget(event.target instanceof HTMLElement ? event.target : null);
      const match = matchShortcut(event, { panelFocused, mode: live.current?.mode ?? mode, typing });
      if (match === "toggle" && event.type === "keydown") {
        event.preventDefault();
        if (open) closePanel(); else openPanel();
      } else if (match === "push_to_talk" && live.current) {
        event.preventDefault();
        if (event.type === "keydown" && !event.repeat && !held.current) { held.current = true; pushToTalk("down"); }
        if (event.type === "keyup" && held.current) { held.current = false; pushToTalk("up"); }
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onKey); };
  }, [open, mode, openPanel, closePanel, pushToTalk]);

  const toggleMute = useCallback(() => {
    setMuted(m => { const next = !m; live.current?.transport?.setMuted(next); return next; });
  }, []);

  const sendText = useCallback((text: string, options: { fromUser?: boolean } = {}) => {
    const current = live.current;
    if (!current || !text.trim()) return;
    if (options.fromUser) current.lastUserWords = text.trim().slice(-LIMITS.userWordsChars);
    current.session.sendText(text);
    addLine("user", text);
    lastSpeech.current = Date.now();
  }, [addLine]);

  const shareFiles = useCallback((files: readonly File[]) => {
    for (const file of files) {
      void (async () => {
        try {
          const projectId = pageContext(window.location.hash).projectId;
          const { document: doc } = await voiceApi.upload(file, projectId);
          const image = await imageDataUrl(file);
          const current = live.current;
          if (current && image) current.session.sendImage(image);
          const cardId = `doc:${doc.id}:${nextId()}`;
          addCard({ kind: "document", id: cardId, document: doc, imageSent: !!(current && image) });
          current?.session.notify(sharedNote(doc, !!(current && image)));
          window.dispatchEvent(new CustomEvent<DataChangedDetail>(DATA_CHANGED_EVENT, { detail: { scopes: ["documents"] } }));
          // Text is read in the background on the server: follow it until it settles, then update the card and tell DAVE.
          if (doc.textState === "pending") {
            for (let i = 0; i < DOC_POLL_TRIES && !unmounted.current.signal.aborted; i++) {
              await new Promise(resolve => window.setTimeout(resolve, DOC_POLL_MS));
              const next = await voiceApi.document(doc.id, unmounted.current.signal).catch(() => null);
              if (!next || next.textState === "pending") continue;
              mutate(e => updateCard(e, cardId, c => c.kind === "document" ? { ...c, document: next } : c));
              const note = documentTextNote(next);
              if (note) live.current?.session.notify(note);
              break;
            }
          }
        } catch (e) {
          addCard({ kind: "action", id: `upload:${nextId()}`, card: { tone: "red", title: `Could not share ${file.name}`, detail: e instanceof Error ? e.message : "Upload failed." } });
        }
      })();
    }
  }, [addCard, mutate, nextId]);

  const findCard = (id: string): VoiceCard | null => {
    for (const e of entriesRef.current) if (e.kind === "card" && e.card.id === id) return e.card;
    return null;
  };

  const answerConfirm = useCallback((cardId: string, accept: boolean) => {
    const card = findCard(cardId);
    const current = live.current;
    if (card?.kind !== "confirm" || card.state !== "open") return;
    if (!current) { mutate(e => updateCard(e, cardId, c => c.kind === "confirm" ? { ...c, state: "failed" } : c)); return; }
    mutate(e => updateCard(e, cardId, c => c.kind === "confirm" ? { ...c, state: "busy" } : c));
    void voiceApi.confirm(current.sessionId, { token: card.confirm.token, accept }, current.abort.signal).then(response => {
      mutate(e => updateCard(e, cardId, c => c.kind === "confirm" ? { ...c, state: !accept ? "declined" : response.ok ? "accepted" : "failed" } : c));
      if (response.card) addCard({ kind: "action", id: `${cardId}:result`, card: response.card, ...(response.ui?.undo ? { undo: undoState(response.ui.undo.batchId) } : {}) });
      if (response.ui?.copy) addCard({ kind: "copy", id: `${cardId}:copy`, copy: response.ui.copy, state: "ready" });
      handleUi(response);
      live.current?.session.notify(confirmNote(card.confirm, accept, response.ok), { respond: true });
    }, () => {
      mutate(e => updateCard(e, cardId, c => c.kind === "confirm" ? { ...c, state: "failed" } : c));
      live.current?.session.notify(confirmNote(card.confirm, accept, false), { respond: true });
    });
  }, [addCard, handleUi, mutate]);

  answerRef.current = answerConfirm;
  // Approve all, by a human click. On success: tell the model and accept every open confirm card, oldest first.
  const setApproval = useCallback((on: boolean) => { const current = live.current; if (current) applyApproval(current, on); }, [applyApproval]);

  const undoCleanUp = useCallback((cardId: string) => {
    const card = findCard(cardId);
    if (card?.kind !== "action" || !card.undo || card.undo.state === "busy" || card.undo.state === "done") return;
    const patch = (state: "busy" | "done" | "failed") => mutate(e => updateCard(e, cardId, c => c.kind === "action" && c.undo ? { ...c, undo: { ...c.undo, state } } : c));
    patch("busy");
    void triageApi.undo(card.undo.batchId).then(() => {
      patch("done");
      window.dispatchEvent(new CustomEvent<DataChangedDetail>(DATA_CHANGED_EVENT, { detail: { scopes: ["meetings", "intel", "portfolio"] } }));
      live.current?.session.notify(UNDO_NOTE);
    }, () => patch("failed"));
  }, [mutate]);

  const copyCard = useCallback((cardId: string) => {
    const card = findCard(cardId);
    if (card?.kind !== "copy") return;
    void navigator.clipboard.writeText(card.copy.text)
      .then(() => intelApi.markSent(card.copy.projectId, card.copy.itemIds, true))
      .then(() => {
        mutate(e => updateCard(e, cardId, c => c.kind === "copy" ? { ...c, state: "copied" } : c));
        window.dispatchEvent(new CustomEvent<DataChangedDetail>(DATA_CHANGED_EVENT, { detail: { scopes: ["intel"] } }));
        live.current?.session.notify(`[Update] The user copied "${card.copy.label}" and DAVE marked ${card.copy.itemIds.length} task(s) sent to EZcoder.`);
      }, () => mutate(e => updateCard(e, cardId, c => c.kind === "copy" ? { ...c, state: "failed" } : c)));
  }, [mutate]);

  const askAbout = useCallback((cardId: string) => {
    const card = findCard(cardId);
    if (card?.kind !== "document") return;
    sendText(`Please read the document "${card.document.name}" (id ${card.document.id}) I shared and tell me what matters in it.`);
  }, [sendText]);

  const saveSettings = useCallback(async (patch: Partial<VoiceSettings>): Promise<string | null> => {
    try { setStatus(await voiceApi.settings(patch)); return null; }
    catch (e) { return e instanceof Error ? e.message : "Could not save settings."; }
  }, []);

  useEffect(() => { if (!live.current && status) setMode(status.settings.mode); }, [status]);

  const lookingAtId = pageContext(hash).projectId;
  const lookingAt = lookingAtId ? focus?.projects.find(p => p.projectId === lookingAtId)?.projectName ?? null : null;

  const value = useMemo<VoiceContextValue>(() => ({
    state, entries, caption, status, settings: status?.settings ?? null, mode, muted, holding, error, chips: focusChips(focus), lookingAt, levels, open,
    openPanel, closePanel, start, end, toggleMute, pushToTalk, sendText, shareFiles, answerConfirm, copyCard, askAbout, saveSettings,
    approval, setApproval, undoCleanUp,
  }), [state, entries, caption, status, mode, muted, holding, error, focus, lookingAt, levels, open, openPanel, closePanel, start, end, toggleMute, pushToTalk, sendText, shareFiles, answerConfirm, copyCard, askAbout, saveSettings, approval, setApproval, undoCleanUp]);

  const announcement = phaseAnnouncement(state.phase === "live" ? { phase: "live", flags: { userSpeaking: false, modelSpeaking: false, responseActive: false, tools: 0 } } : state);
  return <VoiceContext.Provider value={value}>
    {children}
    <div role="status" aria-live="polite" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}>{announcement}</div>
    <div role="status" aria-live="polite" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}>{approvalSaid}</div>
  </VoiceContext.Provider>;
}

export const voiceIsActive = isActive;
