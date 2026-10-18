/**
 * Talk to DAVE: the one live voice session for the paired app (port of
 * src/ui/voice/VoiceProvider.tsx). Wraps the root stack so a conversation
 * survives navigation; the dock and /voice read it through useVoice().
 *
 * Security rules (CLAUDE.md, Voice): writes only prepare a confirm card until
 * the user taps Confirm (single-use server token) or turns on Approve all by a
 * tap; approve_session only carries `userWords` = the user's own last words
 * (their transcript or typed text) — never app notes, documents or tool results.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo } from "react-native";
import { useGlobalSearchParams, usePathname, useRouter, type Href } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { File } from "expo-file-system";
import type { FocusState } from "../../../../src/intel/types.ts";
import type { DaveLevels } from "../../../../src/ui/mascot/types.ts";
import { LIMITS, type ApprovalState, type ApprovalVia, type DocumentMeta, type EndReason, type StartSessionResponse, type ToolCallResponse, type VoiceMode, type VoiceSettings, type VoiceStatus } from "../../../../src/voice/types.ts";
import { INITIAL_VOICE_STATE, isActive, phaseAnnouncement, voiceReducer, type VoiceState } from "../../../../src/ui/voice/machine.ts";
import {
  appendCard, appendLine, approvalAnnouncement, approvalNote, cardsFromToolResponse, confirmNote, contextNote, documentTextNote, focusChips,
  focusUpdateNote, imageSendable, openConfirmIds, sharedNote, transcriptOf, UNDO_NOTE, undoState, updateCard, USER_WORDS_WAIT_MS,
  type FocusChips, type TimelineEntry, type VoiceCard,
} from "../../../../src/ui/voice/model.ts";
import { createRealtimeSession, type RealtimeSession } from "../../../../src/ui/voice/realtime-session.ts";
import { ApiError, describeError } from "../../lib/api";
import { useApi } from "../../lib/connection";
import { announceDataChanged, onDataChanged } from "../../lib/data-events";
import { bytesToBase64, CONNECT_REASONS, isModelImageType, mimeOf, NOT_AVAILABLE_MESSAGE, phonePageContext, unavailableReason, webRouteToPhoneHref, type RouteParams } from "./model";
import { playChime } from "./sounds";
import { connectTransport, TransportError, type Transport } from "./transport";

const FOCUS_POLL_MS = 90_000;
const IDLE_END_MS = 5 * 60_000;
const DOC_POLL_MS = 1_000;
const DOC_POLL_TRIES = 45;

/** A file picked on the phone (document picker, photo library or camera). */
export type PickedFile = { name: string; uri: string; mimeType?: string | null; size?: number | null };
export type VoiceError = { message: string; connect: boolean; settings: boolean };

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
  start: () => void;
  end: (reason?: EndReason) => void;
  toggleMute: () => void;
  pushToTalk: (edge: "down" | "up") => void;
  /** fromUser: typed by the user (counts as the user's own words for approve_session). */
  sendText: (text: string, options?: { fromUser?: boolean }) => void;
  approval: { on: boolean; via: ApprovalVia | null };
  setApproval: (on: boolean) => void;
  approveOnStart: boolean;
  setApproveOnStart: (on: boolean) => void;
  undoCleanUp: (cardId: string) => void;
  shareFiles: (files: readonly PickedFile[]) => void;
  answerConfirm: (cardId: string, accept: boolean) => void;
  copyCard: (cardId: string) => void;
  askAbout: (cardId: string) => void;
  saveSettings: (patch: Partial<VoiceSettings>) => Promise<string | null>;
  reloadStatus: () => void;
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
  transcriptPending: boolean;
  transcriptWaiters: (() => void)[];
};
function releaseWaiters(current: Live): void {
  current.transcriptPending = false;
  for (const resume of current.transcriptWaiters.splice(0)) resume();
}
function waitForTranscript(current: Live): Promise<void> {
  if (!current.transcriptPending) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { current.transcriptWaiters = current.transcriptWaiters.filter((w) => w !== done); resolve(); }, USER_WORDS_WAIT_MS);
    const done = () => { clearTimeout(timer); resolve(); };
    current.transcriptWaiters.push(done);
  });
}
const ZERO_LEVELS: DaveLevels = { input: () => 0, output: () => 0 };
const nowIso = () => new Date().toISOString();
const enc = encodeURIComponent;
const message = (e: unknown, fallback: string) => describeError(e, fallback);

export function VoiceProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const router = useRouter();
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const [state, dispatch] = useReducer(voiceReducer, INITIAL_VOICE_STATE);
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [caption, setCaption] = useState({ user: "", assistant: "" });
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [muted, setMuted] = useState(false);
  const [holding, setHolding] = useState(false);
  const [error, setError] = useState<VoiceError | null>(null);
  const [focus, setFocus] = useState<FocusState | null>(null);
  const [mode, setMode] = useState<VoiceMode>("hands_free");
  const [levels, setLevels] = useState<DaveLevels>(ZERO_LEVELS);
  const [approval, setApprovalState] = useState<{ on: boolean; via: ApprovalVia | null }>({ on: false, via: null });
  const [approveOnStart, setApproveOnStart] = useState(false);
  const approveOnStartRef = useRef(false);
  approveOnStartRef.current = approveOnStart;
  const live = useRef<Live | null>(null);
  const unmounted = useRef(new AbortController());
  const entriesRef = useRef<TimelineEntry[]>([]);
  const focusRef = useRef<FocusState | null>(null);
  const lastSpeech = useRef(Date.now());
  const seq = useRef(0);
  const statusRef = useRef<VoiceStatus | null>(null);
  statusRef.current = status;
  const apiRef = useRef(api);
  apiRef.current = api;
  // Where the user is, as a web route (expo-router params are strings or arrays).
  const routeParams: RouteParams = params;
  const context = phonePageContext(pathname, routeParams);
  const contextRef = useRef(context);
  contextRef.current = context;
  const nextId = useCallback(() => `v${++seq.current}`, []);
  const sounds = () => statusRef.current?.settings.sounds ?? true;

  const mutate = useCallback((fn: (e: TimelineEntry[]) => TimelineEntry[]) => {
    setEntries((prev) => { const next = fn(prev); entriesRef.current = next; return next; });
  }, []);
  const addLine = useCallback((role: "user" | "assistant" | "system", text: string) => mutate((e) => appendLine(e, role, text, nowIso(), nextId())), [mutate, nextId]);
  const addCard = useCallback((card: VoiceCard) => mutate((e) => appendCard(e, card)), [mutate]);

  const reloadStatus = useCallback(() => {
    void apiRef.current.get<VoiceStatus>("/api/voice/status", { signal: unmounted.current.signal }).then(setStatus, () => undefined);
  }, []);
  useEffect(() => { reloadStatus(); }, [reloadStatus]);

  const postEnd = (current: Live, reason: EndReason) =>
    apiRef.current.post<{ ok: true; summary: string | null }>(`/api/voice/sessions/${enc(current.sessionId)}/end`, { reason, transcript: transcriptOf(entriesRef.current) }, { timeoutMs: 60_000 });

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
    void postEnd(current, reason).catch(() => undefined).finally(() => dispatch({ type: "ended" }));
  }, []);

  const fail = useCallback((code: string, text: string, connect = false, settings = false) => {
    setError({ message: text, connect, settings });
    const current = live.current;
    if (current) {
      live.current = null;
      current.session.close(); current.transport?.close(); current.abort.abort();
      releaseWaiters(current);
      setLevels(ZERO_LEVELS);
      void postEnd(current, code === "session_expired" ? "expired" : code === "closed" ? "closed" : "error").catch(() => undefined);
    }
    setApprovalState({ on: false, via: null });
    setHolding(false);
    dispatch({ type: "fail", code, message: text });
  }, []);

  const handleUi = useCallback((response: ToolCallResponse) => {
    const ui = response.ui;
    const href = ui?.navigate ? webRouteToPhoneHref(ui.navigate) : null;
    if (href) router.push(href as Href);
    if (ui?.refresh?.length) announceDataChanged(ui.refresh);
  }, [router]);

  const runTool = useCallback((current: Live, callId: string, name: string, args: Record<string, unknown>) => {
    dispatch({ type: "tool", delta: 1 });
    // Only approve_session carries the user's own words; wait briefly for a transcript still on its way.
    const request = name === "approve_session"
      ? waitForTranscript(current).then(() => ({ callId, name, args, ...(current.lastUserWords ? { userWords: current.lastUserWords } : {}) }))
      : Promise.resolve({ callId, name, args });
    void request
      .then((body) => apiRef.current.post<ToolCallResponse>(`/api/voice/sessions/${enc(current.sessionId)}/tools`, body, { signal: current.abort.signal, timeoutMs: 90_000 }))
      .then((response) => {
        if (live.current !== current) return;
        if (name === "approve_session" && response.ok && typeof args.on === "boolean") {
          const on = args.on;
          setApprovalState({ on, via: on ? "voice" : null });
          AccessibilityInfo.announceForAccessibility(approvalAnnouncement(on));
        }
        current.session.submitResult(callId, response.output);
        for (const card of cardsFromToolResponse(callId, response)) addCard(card);
        handleUi(response);
        if (response.endSession) {
          current.endAfterSpeech = true;
          setTimeout(() => { if (live.current === current) end("assistant"); }, 10_000);
        }
      }, (e: unknown) => {
        if (live.current !== current) return;
        current.session.submitResult(callId, JSON.stringify({ ok: false, error: message(e, "The tool failed.") }));
      })
      .finally(() => dispatch({ type: "tool", delta: -1 }));
  }, [addCard, end, handleUi]);

  const answerRef = useRef<(cardId: string, accept: boolean) => void>(() => undefined);
  /** Approve all by a human tap only (the server records via: "button"). */
  const applyApproval = useCallback((current: Live, on: boolean) => {
    void apiRef.current.post<ApprovalState>(`/api/voice/sessions/${enc(current.sessionId)}/approval`, { on }, { signal: current.abort.signal }).then((next) => {
      if (live.current !== current) return;
      setApprovalState({ on: next.on, via: next.via });
      AccessibilityInfo.announceForAccessibility(approvalAnnouncement(next.on));
      current.session.notify(approvalNote(next.on));
      if (!next.on) return;
      mutate((e) => e.map((x) => x.kind === "card" && x.card.kind === "approval" ? { ...x, card: { ...x.card, state: "on" } } : x));
      for (const id of openConfirmIds(entriesRef.current)) answerRef.current(id, true);
    }, (e: unknown) => {
      if (live.current !== current) return;
      addCard({ kind: "action", id: `approval:${nextId()}`, card: { tone: "red", title: "Approve all did not switch", detail: message(e, "Try again.") } });
    });
  }, [addCard, mutate, nextId]);

  const start = useCallback(() => {
    if (live.current) return;
    setError(null);
    setCaption({ user: "", assistant: "" });
    mutate(() => []);
    dispatch({ type: "start" });
    const abort = new AbortController();
    const startContext = contextRef.current;
    void (async () => {
      let started: StartSessionResponse;
      try { started = await apiRef.current.post<StartSessionResponse>("/api/voice/sessions", { context: startContext }, { signal: abort.signal }); }
      catch (e) {
        const reason = e instanceof ApiError ? unavailableReason(e.body) : null;
        const text = e instanceof ApiError && e.status === 404 ? NOT_AVAILABLE_MESSAGE : message(e, "Voice could not start.");
        setError({ message: text, connect: reason !== null && CONNECT_REASONS.includes(reason), settings: false });
        dispatch({ type: "fail", code: reason ?? "start_failed", message: text });
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
              if (approveOnStartRef.current) applyApproval(current, true);
            },
            onFunctionCall: (call) => { if (live.current === current) runTool(current, call.callId, call.name, call.args); },
            onCaption: (role, text) => setCaption((c) => ({ ...c, [role]: text })),
            onTranscript: (role, text) => {
              addLine(role, text);
              if (role !== "user") return;
              lastSpeech.current = Date.now();
              current.lastUserWords = text.slice(-LIMITS.userWordsChars);
              releaseWaiters(current);
            },
            onModelSpeaking: (speaking) => {
              current.modelSpeaking = speaking;
              dispatch({ type: "model_speaking", speaking });
              if (speaking) lastSpeech.current = Date.now();
              else if (current.endAfterSpeech && live.current === current) end("assistant");
            },
            onUserSpeech: (speaking) => {
              dispatch({ type: "user_speech", speaking }); lastSpeech.current = Date.now();
              if (!speaking) current.transcriptPending = true;
            },
            onResponseActive: (active) => dispatch({ type: "response", active }),
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
        transportRef = await connectTransport({
          secret: started.secret, signal: abort.signal, gated: started.mode === "push_to_talk",
          onOpen: () => { if (live.current === current) current.session.open(); },
          onClose: () => { if (live.current === current) current.session.handleClose(); },
        });
        transportRef.channel.onMessage((event) => { for (const h of handlers) h(event); });
      } catch (e) {
        if (live.current !== current) return;
        const code = e instanceof TransportError ? e.code : "connect_failed";
        fail(code, message(e, "Could not connect voice."), false, code === "mic_denied");
        return;
      }
      if (live.current !== current) { transportRef.close(); return; }
      current.transport = transportRef;
      transportRef.setMuted(false);
      setMuted(false);
      setLevels(transportRef.levels);
    })();
  }, [addLine, applyApproval, end, fail, mutate, runTool]);

  // Unmount (unpair or app teardown): hang up.
  useEffect(() => { const ac = new AbortController(); unmounted.current = ac; return () => ac.abort(); }, []);
  useEffect(() => () => { const current = live.current; if (current) { live.current = null; current.session.close(); current.transport?.close(); current.abort.abort(); } }, []);

  const phase = state.phase;
  // Screen changes tell the model where the user is (the web's hashchange).
  const contextKey = `${context.route}|${context.projectId ?? ""}`;
  const lastContextKey = useRef(contextKey);
  useEffect(() => {
    if (lastContextKey.current === contextKey) return;
    lastContextKey.current = contextKey;
    if (phase !== "live") return;
    const ctx = contextRef.current;
    const name = ctx.projectId ? focusRef.current?.projects.find((p) => p.projectId === ctx.projectId)?.projectName ?? null : null;
    live.current?.session.notify(contextNote(ctx, name));
  }, [contextKey, phase]);

  // Live updates from the focus queue.
  useEffect(() => {
    if (phase !== "live") return;
    const ac = new AbortController();
    const poll = () => {
      void apiRef.current.get<FocusState>("/api/intel/focus", { signal: ac.signal }).then((next) => {
        if (ac.signal.aborted) return;
        const note = focusUpdateNote(focusRef.current, next);
        focusRef.current = next;
        setFocus(next);
        if (note) live.current?.session.notify(note);
      }, () => undefined);
    };
    poll();
    const timer = setInterval(poll, FOCUS_POLL_MS);
    const stop = onDataChanged((scopes) => { if (scopes.some((s) => s === "intel" || s === "meetings")) poll(); });
    return () => { ac.abort(); clearInterval(timer); stop(); };
  }, [phase]);

  // Idle auto-end in hands-free mode.
  useEffect(() => {
    if (phase !== "live" || mode !== "hands_free") return;
    const timer = setInterval(() => {
      if (live.current && !live.current.modelSpeaking && Date.now() - lastSpeech.current > IDLE_END_MS) end("idle");
    }, 15_000);
    return () => clearInterval(timer);
  }, [phase, mode, end]);

  // Phase-level announcements (the web's polite status region).
  const announcement = phaseAnnouncement(phase === "live" ? { phase: "live", flags: { userSpeaking: false, modelSpeaking: false, responseActive: false, tools: 0 } } : state);
  useEffect(() => { if (announcement) AccessibilityInfo.announceForAccessibility(announcement); }, [announcement]);

  const pushToTalk = useCallback((edge: "down" | "up") => {
    const current = live.current;
    if (!current?.transport || current.mode !== "push_to_talk") return;
    current.transport.setGateOpen(edge === "down");
    current.session.pushToTalk(edge);
    setHolding(edge === "down");
    lastSpeech.current = Date.now();
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((m) => { const next = !m; live.current?.transport?.setMuted(next); return next; });
  }, []);

  const sendText = useCallback((text: string, options: { fromUser?: boolean } = {}) => {
    const current = live.current;
    if (!current || !text.trim()) return;
    if (options.fromUser) current.lastUserWords = text.trim().slice(-LIMITS.userWordsChars);
    current.session.sendText(text);
    addLine("user", text);
    lastSpeech.current = Date.now();
  }, [addLine]);

  const shareFiles = useCallback((files: readonly PickedFile[]) => {
    for (const file of files) {
      void (async () => {
        try {
          if (file.size && file.size > LIMITS.uploadBytes) throw new Error("That file is larger than 25 MB, the most DAVE accepts.");
          const bytes = await new File(file.uri).bytes();
          const projectId = contextRef.current.projectId;
          const { document: doc } = await apiRef.current.upload<{ document: DocumentMeta; duplicate: boolean }>({ name: file.name || "file", bytes, projectId }, { timeoutMs: 120_000 });
          const mime = mimeOf(file.name, file.mimeType);
          // No on-device resize: only images already small enough go to the model directly; the rest are read on the Mac.
          const url = isModelImageType(mime) && Math.ceil(bytes.length / 3) * 4 < LIMITS.imageDataUrlChars ? `data:${mime};base64,${bytesToBase64(bytes)}` : null;
          const image = url && imageSendable(url) ? url : null;
          const current = live.current;
          if (current && image) current.session.sendImage(image);
          const cardId = `doc:${doc.id}:${nextId()}`;
          addCard({ kind: "document", id: cardId, document: doc, imageSent: !!(current && image) });
          current?.session.notify(sharedNote(doc, !!(current && image)));
          announceDataChanged(["documents"]);
          if (doc.textState === "pending") {
            for (let i = 0; i < DOC_POLL_TRIES && !unmounted.current.signal.aborted; i++) {
              await new Promise((resolve) => setTimeout(resolve, DOC_POLL_MS));
              const next = await apiRef.current.get<DocumentMeta>(`/api/files/${enc(doc.id)}`, { signal: unmounted.current.signal }).catch(() => null);
              if (!next || next.textState === "pending") continue;
              mutate((e) => updateCard(e, cardId, (c) => c.kind === "document" ? { ...c, document: next } : c));
              const note = documentTextNote(next);
              if (note) live.current?.session.notify(note);
              break;
            }
          }
        } catch (e) {
          addCard({ kind: "action", id: `upload:${nextId()}`, card: { tone: "red", title: `Could not share ${file.name}`, detail: message(e, "Upload failed.") } });
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
    if (!current) { mutate((e) => updateCard(e, cardId, (c) => c.kind === "confirm" ? { ...c, state: "failed" } : c)); return; }
    mutate((e) => updateCard(e, cardId, (c) => c.kind === "confirm" ? { ...c, state: "busy" } : c));
    void apiRef.current.post<ToolCallResponse>(`/api/voice/sessions/${enc(current.sessionId)}/confirm`, { token: card.confirm.token, accept }, { signal: current.abort.signal, timeoutMs: 90_000 }).then((response) => {
      mutate((e) => updateCard(e, cardId, (c) => c.kind === "confirm" ? { ...c, state: !accept ? "declined" : response.ok ? "accepted" : "failed" } : c));
      if (response.card) addCard({ kind: "action", id: `${cardId}:result`, card: response.card, ...(response.ui?.undo ? { undo: undoState(response.ui.undo.batchId) } : {}) });
      if (response.ui?.copy) addCard({ kind: "copy", id: `${cardId}:copy`, copy: response.ui.copy, state: "ready" });
      handleUi(response);
      live.current?.session.notify(confirmNote(card.confirm, accept, response.ok), { respond: true });
    }, () => {
      mutate((e) => updateCard(e, cardId, (c) => c.kind === "confirm" ? { ...c, state: "failed" } : c));
      live.current?.session.notify(confirmNote(card.confirm, accept, false), { respond: true });
    });
  }, [addCard, handleUi, mutate]);
  answerRef.current = answerConfirm;

  const setApproval = useCallback((on: boolean) => { const current = live.current; if (current) applyApproval(current, on); }, [applyApproval]);

  const undoCleanUp = useCallback((cardId: string) => {
    const card = findCard(cardId);
    if (card?.kind !== "action" || !card.undo || card.undo.state === "busy" || card.undo.state === "done") return;
    const patch = (next: "busy" | "done" | "failed") => mutate((e) => updateCard(e, cardId, (c) => c.kind === "action" && c.undo ? { ...c, undo: { ...c.undo, state: next } } : c));
    patch("busy");
    void apiRef.current.post("/api/triage/undo", { batchId: card.undo.batchId }).then(() => {
      patch("done");
      announceDataChanged(["meetings", "intel", "portfolio"]);
      live.current?.session.notify(UNDO_NOTE);
    }, () => patch("failed"));
  }, [mutate]);

  const copyCard = useCallback((cardId: string) => {
    const card = findCard(cardId);
    if (card?.kind !== "copy") return;
    void Clipboard.setStringAsync(card.copy.text)
      .then(() => apiRef.current.post(`/api/intel/projects/${enc(card.copy.projectId)}/tasks/sent`, { itemIds: card.copy.itemIds, sent: true }))
      .then(() => {
        mutate((e) => updateCard(e, cardId, (c) => c.kind === "copy" ? { ...c, state: "copied" } : c));
        announceDataChanged(["intel"]);
        live.current?.session.notify(`[Update] The user copied "${card.copy.label}" and DAVE marked ${card.copy.itemIds.length} task(s) sent to EZcoder.`);
      }, () => mutate((e) => updateCard(e, cardId, (c) => c.kind === "copy" ? { ...c, state: "failed" } : c)));
  }, [mutate]);

  const askAbout = useCallback((cardId: string) => {
    const card = findCard(cardId);
    if (card?.kind !== "document") return;
    // Not fromUser: an app-generated request never counts as the user's words for approval.
    sendText(`Please read the document "${card.document.name}" (id ${card.document.id}) I shared and tell me what matters in it.`);
  }, [sendText]);

  const saveSettings = useCallback(async (patch: Partial<VoiceSettings>): Promise<string | null> => {
    try { setStatus(await apiRef.current.post<VoiceStatus>("/api/voice/settings", patch)); return null; }
    catch (e) { return message(e, "Could not save settings."); }
  }, []);

  useEffect(() => { if (!live.current && status) setMode(status.settings.mode); }, [status]);

  const lookingAtId = context.projectId;
  const lookingAt = lookingAtId ? focus?.projects.find((p) => p.projectId === lookingAtId)?.projectName ?? null : null;

  const value = useMemo<VoiceContextValue>(() => ({
    state, entries, caption, status, settings: status?.settings ?? null, mode, muted, holding, error, chips: focusChips(focus), lookingAt, levels,
    start, end, toggleMute, pushToTalk, sendText, shareFiles, answerConfirm, copyCard, askAbout, saveSettings, reloadStatus,
    approval, setApproval, approveOnStart, setApproveOnStart, undoCleanUp,
  }), [state, entries, caption, status, mode, muted, holding, error, focus, lookingAt, levels, start, end, toggleMute, pushToTalk, sendText, shareFiles, answerConfirm, copyCard, askAbout, saveSettings, reloadStatus, approval, setApproval, approveOnStart, undoCleanUp]);

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

export const voiceIsActive = isActive;
