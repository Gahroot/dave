/**
 * Talk to DAVE: the contract between the voice backend (src/voice/*, src/server/voice-routes.ts,
 * src/documents/*, src/server/document-routes.ts) and the voice UI (src/ui/voice/*).
 * Type-only plus constants: no Node imports, so the browser bundle can import it.
 *
 * The ChatGPT access token never reaches the browser. The browser only ever receives a short-lived Realtime
 * client secret (ek_…) minted by the server for one session.
 *
 * Routes (all under the loopback CSRF/origin guard):
 *  GET  /api/voice/status                          -> VoiceStatus
 *  POST /api/voice/settings      Partial<VoiceSettings> -> VoiceStatus
 *  POST /api/voice/sessions      StartSessionRequest    -> StartSessionResponse   (503 {error, message, reason} when unavailable)
 *  POST /api/voice/sessions/:id/tools   ToolCallRequest     -> ToolCallResponse
 *  POST /api/voice/sessions/:id/confirm ConfirmClickRequest -> ToolCallResponse
 *  POST /api/voice/sessions/:id/approval ApprovalRequest   -> ApprovalState   (a human click; 404 for a session that is not live)
 *  POST /api/voice/sessions/:id/end     EndSessionRequest   -> {ok: true, summary: string | null}
 *  GET  /api/voice/history                          -> {sessions: VoiceHistoryEntry[]}
 *  GET  /api/voice/memory                           -> VoiceMemory
 *  POST /api/files               raw bytes (application/octet-stream; x-dave-filename URL-encoded; x-dave-project?) -> UploadResponse
 *  GET  /api/files?projectId=                       -> {documents: DocumentMeta[]}
 *  GET  /api/files/:id                              -> DocumentMeta
 *  GET  /api/files/:id/content                      -> image or PDF bytes only
 *  POST /api/files/:id/project   {projectId: string | null} -> DocumentMeta
 *  POST /api/files/:id/delete    {}                 -> {ok: true}
 */
import type { DirectionNote } from "../intel/types.ts";

export const VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"] as const;
export type VoiceName = (typeof VOICES)[number];
export const MODELS = ["gpt-realtime-2.1", "gpt-realtime-2.1-mini", "gpt-realtime-2", "gpt-realtime"] as const;
export type RealtimeModel = (typeof MODELS)[number];
export const DEFAULT_VOICE: VoiceName = "marin";
export const DEFAULT_MODEL: RealtimeModel = "gpt-realtime-2.1";

export type VoiceMode = "hands_free" | "push_to_talk";
export const VOICE_MODES: readonly VoiceMode[] = ["hands_free", "push_to_talk"];

/** How the Talk to DAVE stage looks. Display only: it never reaches the model. */
export type VoiceTheme = "dark" | "light";
export const VOICE_THEMES: readonly VoiceTheme[] = ["dark", "light"];

export type VoiceSettings = {
  voice: VoiceName;
  model: RealtimeModel;
  /** DAVE speaks first with one short greeting and the biggest alignment gap. */
  greeting: boolean;
  mode: VoiceMode;
  /** Start/stop chimes. */
  sounds: boolean;
  /** The dark LED stage (default) or the light stage. Applies at once, to the panel, the dock and the DAVE bot. */
  theme: VoiceTheme;
};
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = { voice: DEFAULT_VOICE, model: DEFAULT_MODEL, greeting: true, mode: "hands_free", sounds: true, theme: "dark" };

/** Why voice cannot start. Every reason maps to one plain message; none carries provider text. */
export type VoiceUnavailableReason = "disabled" | "not_connected" | "reconnect" | "not_entitled" | "rate_limited" | "mint_failed";
export type VoiceAvailability = {
  /** check_on_start: OpenAI may be connected but DAVE has not read the Keychain yet; Start will check. */
  state: "ready" | "check_on_start" | "unavailable";
  reason: VoiceUnavailableReason | null;
  message: string;
};

export type VoiceStatus = {
  settings: VoiceSettings;
  availability: VoiceAvailability;
  voices: readonly VoiceName[];
  models: readonly RealtimeModel[];
  /** What leaves the machine, shown under the Talk button. */
  disclosure: string;
};

/** Where the user is in the app when a session starts or the page changes. */
export type PageContext = { route: string; projectId: string | null };
export type StartSessionRequest = { context: PageContext };
export type StartSessionResponse = {
  sessionId: string;
  /** Ephemeral Realtime client secret (ek_…). Used once by the browser for the SDP exchange. */
  secret: string;
  /** Epoch seconds, as returned by OpenAI. */
  expiresAt: number;
  model: RealtimeModel;
  voice: VoiceName;
  /** GA Realtime session object; the client applies it verbatim with session.update. */
  session: Record<string, unknown>;
  greeting: boolean;
  mode: VoiceMode;
};

export type DataScope = "intel" | "portfolio" | "meetings" | "documents";
export const DATA_SCOPES: readonly DataScope[] = ["intel", "portfolio", "meetings", "documents"];
export type CardTone = "amber" | "blue" | "green" | "red" | "gray" | "violet";

export type ToolCallRequest = {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  /**
   * The user's own most recent words (spoken transcript or typed text), at most LIMITS.userWordsChars. Only
   * approve_session reads it: approval switches on only when these words grant it. App notes, documents and tool
   * results are never sent here.
   */
  userWords?: string;
};

/**
 * "Approve all for this session": while on, write tools apply at once instead of preparing a confirm card.
 * In memory only, per live session; it ends with the session. Switched on by the Approve all button or by
 * approve_session when the user's own words grant it.
 */
export type ApprovalVia = "button" | "voice";
export type ApprovalState = { on: boolean; via: ApprovalVia | null; at: string | null };
export type ApprovalRequest = { on: boolean };

/** A write waiting for "yes". The server holds the exact action; the token is single-use, session-bound, 120 s. */
export type ConfirmCard = { token: string; title: string; say: string; details: string[]; expiresAt: string };
export type UiDirective = {
  /** A same-app hash route, e.g. "#focus?project=p1". Always validated server-side. */
  navigate?: string;
  /** Data the UI should reload. */
  refresh?: DataScope[];
  /** A copy card: copying the text marks the items sent to EZcoder (intelApi.markSent). */
  copy?: { label: string; text: string; projectId: string; itemIds: string[] };
  /** Show the "Approve all for this session" card (approve_session was refused without the user's own words). */
  offerApproval?: boolean;
  /** A clean-up batch the UI can offer to undo (POST /api/triage/undo). */
  undo?: { batchId: string };
};
export type ActionCard = { tone: CardTone; title: string; detail?: string; link?: string };

export type ToolCallResponse = {
  ok: boolean;
  /** JSON text the client passes verbatim as the function_call_output. Already speakable (redacted, no paths/URLs). */
  output: string;
  error?: string;
  endSession?: boolean;
  confirm?: ConfirmCard;
  ui?: UiDirective;
  card?: ActionCard;
};

export type ConfirmClickRequest = { token: string; accept: boolean };

export type TranscriptRole = "user" | "assistant" | "system";
export type TranscriptLine = { role: TranscriptRole; text: string; at: string };
export type EndReason = "user" | "idle" | "assistant" | "error" | "expired" | "closed";
export const END_REASONS: readonly EndReason[] = ["user", "idle", "assistant", "error", "expired", "closed"];
export type EndSessionRequest = { reason: EndReason; transcript: TranscriptLine[] };

export type VoiceHistoryEntry = {
  id: string;
  startedAt: string;
  endedAt: string | null;
  projectId: string | null;
  projectName: string | null;
  model: string;
  voice: string;
  endReason: EndReason | null;
  summary: string | null;
  lines: number;
  actions: number;
};

/** GET /api/voice/memory: the notes DAVE remembers (newest first). Delete goes through /api/intel/notes/:id/delete. */
export type VoiceMemory = { notes: (DirectionNote & { projectName: string | null })[] };

export type DocumentKind = "pdf" | "image" | "text" | "word" | "rtf" | "html";
export type DocumentTextState = "pending" | "ready" | "unavailable" | "failed";
export type DocumentMeta = {
  id: string;
  name: string;
  kind: DocumentKind;
  size: number;
  pages: number | null;
  textState: DocumentTextState;
  projectId: string | null;
  projectName: string | null;
  createdAt: string;
  textChars: number;
  /** Deliverables found by parseAgreement in the extracted text (0 until text is ready). */
  agreementCandidates: number;
};
export type UploadResponse = { document: DocumentMeta; duplicate: boolean };

export const LIMITS = {
  uploadBytes: 25 * 1024 * 1024,
  imageDataUrlChars: 200_000,
  transcriptLines: 400,
  transcriptLineChars: 2_000,
  /** The end request is a guarded JSON body (64 KB ceiling); the posted transcript keeps the newest lines within this. */
  transcriptBodyBytes: 56 * 1024,
  readWindowChars: 6_000,
  /** ToolCallRequest.userWords. */
  userWordsChars: 2_000,
} as const;

/** window CustomEvent; detail: {scopes: DataScope[]}. */
export const DATA_CHANGED_EVENT = "dave:data-changed";
export type DataChangedDetail = { scopes: DataScope[] };
