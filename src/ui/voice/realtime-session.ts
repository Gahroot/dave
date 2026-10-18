/**
 * Talk to DAVE: the Realtime (GA) protocol layer over the "oai-events" data channel. Pure: no browser APIs.
 * Original code; it follows the public OpenAI Realtime event protocol.
 */

export type RealtimeChannel = {
  send: (event: Record<string, unknown>) => void;
  onMessage: (handler: (event: unknown) => void) => void;
};

export type FunctionCall = { callId: string; name: string; args: Record<string, unknown> };
export type CaptionRole = "user" | "assistant";

export type RealtimeSessionEvents = {
  onReady?: () => void;
  onFunctionCall?: (call: FunctionCall) => void;
  /** Live caption text so far (replaces the previous caption for that role). Empty string clears it. */
  onCaption?: (role: CaptionRole, text: string) => void;
  /** A final transcript line. */
  onTranscript?: (role: CaptionRole, text: string) => void;
  onModelSpeaking?: (speaking: boolean) => void;
  onUserSpeech?: (speaking: boolean) => void;
  onResponseActive?: (active: boolean) => void;
  onFatal?: (code: string, message: string) => void;
  onError?: (code: string, message: string) => void;
};

export type RealtimeSessionOptions = {
  session: Record<string, unknown>;
  greeting: boolean;
  events: RealtimeSessionEvents;
};

export type NotifyOptions = { respond?: boolean };

export const BENIGN_ERRORS: readonly string[] = ["response_cancel_not_active", "conversation_already_has_active_response"];
export const FATAL_ERRORS: readonly string[] = ["session_expired", "invalid_api_key", "model_not_found"];

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => typeof v === "string" ? v : "";

export type RealtimeSession = ReturnType<typeof createRealtimeSession>;

export function createRealtimeSession(channel: RealtimeChannel, options: RealtimeSessionOptions) {
  const { events } = options;
  const seen = new Set<string>();
  const pending = new Set<string>();
  const notes: { text: string; respond: boolean }[] = [];
  let ready = false;
  let closed = false;
  let responseActive = false;
  /** A response.create was sent and response.created has not arrived yet. */
  let responseRequested = false;
  /** Function outputs were submitted and still need one response.create. */
  let needResponse = false;
  let modelSpeaking = false;
  let userSpeaking = false;
  let caption: Record<CaptionRole, string> = { user: "", assistant: "" };

  const send = (event: Rec) => { if (!closed) channel.send(event); };
  const busy = () => responseActive || responseRequested;
  const quiet = () => ready && !closed && !userSpeaking && !modelSpeaking && !busy() && pending.size === 0;

  const requestResponse = () => {
    if (busy()) return;
    responseRequested = true;
    send({ type: "response.create" });
  };

  const settle = () => {
    if (closed || !ready) return;
    if (needResponse && pending.size === 0 && !busy()) {
      needResponse = false;
      requestResponse();
      return;
    }
    if (notes.length && quiet()) {
      const batch = notes.splice(0, notes.length);
      send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: batch.map(n => n.text).join("\n") }] } });
      if (batch.some(n => n.respond)) requestResponse();
    }
  };

  const forward = (callId: string, name: string, rawArgs: unknown) => {
    if (!callId || seen.has(callId)) return;
    seen.add(callId);
    let args: Rec | null = null;
    if (isRec(rawArgs)) args = rawArgs;
    else {
      try { const parsed: unknown = JSON.parse(str(rawArgs) || "{}"); if (isRec(parsed)) args = parsed; } catch { args = null; }
    }
    if (!args) {
      send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ ok: false, error: "The tool arguments were not valid JSON. Try the call again." }) } });
      needResponse = true;
      settle();
      return;
    }
    pending.add(callId);
    events.onFunctionCall?.({ callId, name, args });
  };

  const setCaption = (role: CaptionRole, text: string) => { caption = { ...caption, [role]: text }; events.onCaption?.(role, text); };

  const handle = (raw: unknown) => {
    if (closed) return;
    let event: unknown = raw;
    if (typeof raw === "string") { try { event = JSON.parse(raw); } catch { return; } }
    if (!isRec(event)) return;
    const type = str(event.type);
    switch (type) {
      case "session.updated":
        if (!ready) {
          ready = true;
          events.onReady?.();
          if (options.greeting) requestResponse();
        }
        break;
      case "response.created":
        responseRequested = false;
        responseActive = true;
        events.onResponseActive?.(true);
        break;
      case "response.done": {
        const response = isRec(event.response) ? event.response : {};
        const output = Array.isArray(response.output) ? response.output : [];
        for (const item of output) if (isRec(item) && item.type === "function_call") forward(str(item.call_id), str(item.name), item.arguments);
        responseActive = false;
        responseRequested = false;
        events.onResponseActive?.(false);
        break;
      }
      case "response.function_call_arguments.done":
        forward(str(event.call_id), str(event.name), event.arguments);
        break;
      case "response.output_audio_transcript.delta":
        setCaption("assistant", caption.assistant + str(event.delta));
        break;
      case "response.output_audio_transcript.done": {
        const text = str(event.transcript) || caption.assistant;
        setCaption("assistant", "");
        if (text.trim()) events.onTranscript?.("assistant", text.trim());
        break;
      }
      case "conversation.item.input_audio_transcription.delta":
        setCaption("user", caption.user + str(event.delta));
        break;
      case "conversation.item.input_audio_transcription.completed": {
        const text = str(event.transcript) || caption.user;
        setCaption("user", "");
        if (text.trim()) events.onTranscript?.("user", text.trim());
        break;
      }
      case "output_audio_buffer.started":
        modelSpeaking = true; events.onModelSpeaking?.(true); break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        modelSpeaking = false; events.onModelSpeaking?.(false); break;
      case "input_audio_buffer.speech_started":
        userSpeaking = true; events.onUserSpeech?.(true); break;
      case "input_audio_buffer.speech_stopped":
        userSpeaking = false; events.onUserSpeech?.(false); break;
      case "error": {
        const error = isRec(event.error) ? event.error : {};
        const code = str(error.code) || str(error.type) || "unknown";
        const message = str(error.message);
        if (BENIGN_ERRORS.includes(code)) {
          if (code === "conversation_already_has_active_response") responseRequested = false;
          break;
        }
        if (FATAL_ERRORS.includes(code)) { closed = true; events.onFatal?.(code, message); return; }
        responseRequested = false;
        events.onError?.(code, message);
        break;
      }
      default: return;
    }
    settle();
  };

  channel.onMessage(handle);

  return {
    /** Call when the data channel opens. */
    open() { send({ type: "session.update", session: options.session }); },
    submitResult(callId: string, output: string) {
      if (!pending.has(callId)) return;
      pending.delete(callId);
      send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output } });
      needResponse = true;
      settle();
    },
    notify(text: string, opts: NotifyOptions = {}) {
      const clean = text.trim();
      if (!clean) return;
      notes.push({ text: clean, respond: opts.respond ?? clean.startsWith("[Shared]") });
      settle();
    },
    sendText(text: string) {
      const clean = text.trim();
      if (!clean || !ready) return;
      send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: clean }] } });
      requestResponse();
    },
    sendImage(dataUrl: string) {
      if (!ready) return;
      send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_image", image_url: dataUrl }] } });
    },
    pushToTalk(edge: "down" | "up") {
      if (!ready) return;
      if (edge === "down") { send({ type: "input_audio_buffer.clear" }); userSpeaking = true; return; }
      userSpeaking = false;
      send({ type: "input_audio_buffer.commit" });
      requestResponse();
    },
    /** The data channel closed: nothing else is sent. */
    handleClose() {
      if (closed) return;
      closed = true;
      events.onFatal?.("closed", "The voice connection closed.");
    },
    close() { closed = true; },
    get ready() { return ready; },
    get pendingCalls() { return pending.size; },
    get queuedNotes() { return notes.length; },
  };
}
