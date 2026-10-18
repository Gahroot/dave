import { describe, expect, it } from "vitest";
import { INITIAL_VOICE_STATE, mascotMood, phaseAnnouncement, voiceReducer, voiceStatusLabel, type VoiceAction, type VoiceState } from "../src/ui/voice/machine.ts";

const run = (...actions: VoiceAction[]): VoiceState => actions.reduce(voiceReducer, INITIAL_VOICE_STATE);

describe("voice machine", () => {
  it("walks idle → starting → connecting → live → ending → ended", () => {
    expect(run({ type: "start" }).phase).toBe("starting");
    expect(run({ type: "start" }, { type: "connecting" }).phase).toBe("connecting");
    const live = run({ type: "start" }, { type: "connecting" }, { type: "ready" });
    expect(live.phase).toBe("live");
    expect(voiceStatusLabel(live)).toBe("LISTENING");
    const ended = run({ type: "start" }, { type: "connecting" }, { type: "ready" }, { type: "end", reason: "user" }, { type: "ended" });
    expect(ended).toEqual({ phase: "ended", reason: "user" });
    expect(mascotMood(ended)).toBe("sleepy");
  });
  it("derives live activity with tools > speaking > hearing > thinking", () => {
    const base = run({ type: "start" }, { type: "connecting" }, { type: "ready" });
    const thinking = voiceReducer(base, { type: "response", active: true });
    expect(voiceStatusLabel(thinking)).toBe("THINKING");
    const hearing = voiceReducer(thinking, { type: "user_speech", speaking: true });
    expect(mascotMood(hearing)).toBe("hearing");
    const speaking = voiceReducer(hearing, { type: "model_speaking", speaking: true });
    expect(mascotMood(speaking)).toBe("speaking");
    const working = voiceReducer(speaking, { type: "tool", delta: 1 });
    expect(voiceStatusLabel(working)).toBe("WORKING");
    expect(mascotMood(voiceReducer(working, { type: "tool", delta: -1 }))).toBe("speaking");
    expect(phaseAnnouncement(working)).toBe(phaseAnnouncement(base));
  });
  it("ignores out-of-order events and handles errors", () => {
    expect(run({ type: "ready" }).phase).toBe("idle");
    expect(run({ type: "ended" }).phase).toBe("idle");
    expect(run({ type: "fail", code: "x", message: "m" }).phase).toBe("idle");
    const error = run({ type: "start" }, { type: "fail", code: "not_connected", message: "Connect OpenAI first." });
    expect(error).toEqual({ phase: "error", code: "not_connected", message: "Connect OpenAI first." });
    expect(mascotMood(error)).toBe("oops");
    expect(voiceStatusLabel(error)).toBe("TROUBLE");
    expect(phaseAnnouncement(error)).toBe("Connect OpenAI first.");
    expect(run({ type: "start" }, { type: "fail", code: "x", message: "m" }, { type: "start" }).phase).toBe("starting");
    expect(voiceReducer(INITIAL_VOICE_STATE, { type: "tool", delta: -1 })).toBe(INITIAL_VOICE_STATE);
  });
});
