import type { DaveMood } from "../mascot/types.ts";
import type { EndReason } from "../../voice/types.ts";

export type LiveActivity = "listening" | "hearing" | "thinking" | "speaking" | "working";
export type LiveFlags = { userSpeaking: boolean; modelSpeaking: boolean; responseActive: boolean; tools: number };

export type VoiceState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "connecting" }
  | { phase: "live"; flags: LiveFlags }
  | { phase: "ending"; reason: EndReason }
  | { phase: "ended"; reason: EndReason }
  | { phase: "error"; code: string; message: string };

export type VoiceAction =
  | { type: "start" }
  | { type: "connecting" }
  | { type: "ready" }
  | { type: "user_speech"; speaking: boolean }
  | { type: "model_speaking"; speaking: boolean }
  | { type: "response"; active: boolean }
  | { type: "tool"; delta: 1 | -1 }
  | { type: "end"; reason: EndReason }
  | { type: "ended" }
  | { type: "fail"; code: string; message: string }
  | { type: "reset" };

export const INITIAL_VOICE_STATE: VoiceState = { phase: "idle" };
const NO_FLAGS: LiveFlags = { userSpeaking: false, modelSpeaking: false, responseActive: false, tools: 0 };

export function voiceReducer(state: VoiceState, action: VoiceAction): VoiceState {
  switch (action.type) {
    case "start":
      return state.phase === "idle" || state.phase === "ended" || state.phase === "error" ? { phase: "starting" } : state;
    case "connecting":
      return state.phase === "starting" ? { phase: "connecting" } : state;
    case "ready":
      return state.phase === "connecting" || state.phase === "starting" ? { phase: "live", flags: NO_FLAGS } : state;
    case "user_speech":
      return state.phase === "live" ? { phase: "live", flags: { ...state.flags, userSpeaking: action.speaking } } : state;
    case "model_speaking":
      return state.phase === "live" ? { phase: "live", flags: { ...state.flags, modelSpeaking: action.speaking } } : state;
    case "response":
      return state.phase === "live" ? { phase: "live", flags: { ...state.flags, responseActive: action.active } } : state;
    case "tool":
      return state.phase === "live" ? { phase: "live", flags: { ...state.flags, tools: Math.max(0, state.flags.tools + action.delta) } } : state;
    case "end":
      return state.phase === "starting" || state.phase === "connecting" || state.phase === "live" ? { phase: "ending", reason: action.reason } : state;
    case "ended":
      return state.phase === "ending" ? { phase: "ended", reason: state.reason } : state;
    case "fail":
      return state.phase === "idle" ? state : { phase: "error", code: action.code, message: action.message };
    case "reset":
      return state.phase === "ended" || state.phase === "error" ? { phase: "idle" } : state;
  }
}

export function liveActivity(flags: LiveFlags): LiveActivity {
  if (flags.tools > 0) return "working";
  if (flags.modelSpeaking) return "speaking";
  if (flags.userSpeaking) return "hearing";
  if (flags.responseActive) return "thinking";
  return "listening";
}

export const isActive = (state: VoiceState): boolean => state.phase === "starting" || state.phase === "connecting" || state.phase === "live";

const LIVE_LABEL: Record<LiveActivity, string> = { listening: "LISTENING", hearing: "HEARING YOU", thinking: "THINKING", speaking: "TALKING", working: "WORKING" };

export function voiceStatusLabel(state: VoiceState): string {
  switch (state.phase) {
    case "idle": return "READY";
    case "starting": return "STARTING";
    case "connecting": return "CONNECTING";
    case "live": return LIVE_LABEL[liveActivity(state.flags)];
    case "ending": return "ENDING";
    case "ended": return "SEE YOU";
    case "error": return "TROUBLE";
  }
}

/** Phase-level wording for the single polite status region (never per token or per activity). */
export function phaseAnnouncement(state: VoiceState): string {
  switch (state.phase) {
    case "idle": return "";
    case "starting": return "Starting a conversation with DAVE.";
    case "connecting": return "Connecting to DAVE.";
    case "live": return "DAVE is listening.";
    case "ending": return "Ending the conversation.";
    case "ended": return "Conversation ended.";
    case "error": return state.message || "DAVE is having trouble.";
  }
}

export function mascotMood(state: VoiceState): DaveMood {
  switch (state.phase) {
    case "idle": return "idle";
    case "starting":
    case "connecting": return "thinking";
    case "live": return liveActivity(state.flags);
    case "ending": return "happy";
    case "ended": return "sleepy";
    case "error": return "oops";
  }
}
