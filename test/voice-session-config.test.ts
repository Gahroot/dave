import { describe, expect, it } from "vitest";
import { realtimeSession } from "../src/voice/session-config.ts";
import { VOICE_TOOLS } from "../src/voice/tools.ts";
import { voiceInstructions } from "../src/voice/instructions.ts";

describe("realtimeSession", () => {
  it("builds the GA hands-free shape without a model", () => {
    const s = realtimeSession({ instructions: "be DAVE", voice: "marin", mode: "hands_free", tools: VOICE_TOOLS });
    expect(s).not.toHaveProperty("model");
    expect(s).toMatchObject({
      type: "realtime", instructions: "be DAVE", output_modalities: ["audio"], tool_choice: "auto",
      audio: { input: { noise_reduction: { type: "near_field" }, transcription: { model: "gpt-4o-mini-transcribe" },
        turn_detection: { type: "server_vad", threshold: 0.6, prefix_padding_ms: 300, silence_duration_ms: 650, create_response: true, interrupt_response: true } }, output: { voice: "marin" } },
    });
    const tools = s.tools as { type: string; name: string; parameters: { type: string } }[];
    expect(tools).toHaveLength(VOICE_TOOLS.length);
    for (const t of tools) { expect(t.type).toBe("function"); expect(t.parameters.type).toBe("object"); }
  });
  it("push-to-talk turns VAD off", () => {
    const s = realtimeSession({ instructions: "x", voice: "cedar", mode: "push_to_talk", tools: [] });
    expect((s.audio as { input: { turn_detection: unknown } }).input.turn_detection).toBeNull();
  });
  it("instructions carry the persona, the greeting rule and the context", () => {
    const on = voiceInstructions("## Live context\nX", { greeting: true });
    expect(on).toContain("paid");
    expect(on).toContain("[Update]");
    expect(on).toContain("end_session");
    expect(on).toContain("speak first");
    expect(on.endsWith("## Live context\nX")).toBe(true);
    expect(voiceInstructions("c", { greeting: false })).toContain("do not speak first");
  });
});
