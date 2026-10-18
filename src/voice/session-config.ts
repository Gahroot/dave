import type { VoiceMode, VoiceName } from "./types.ts";

export type ToolDefinition = { name: string; description: string; parameters: Record<string, unknown> };

/** GA Realtime session object for session.update. The model is added by mint, never here. */
export function realtimeSession(input: { instructions: string; voice: VoiceName; mode: VoiceMode; tools: readonly ToolDefinition[] }): Record<string, unknown> {
  return {
    type: "realtime",
    instructions: input.instructions,
    output_modalities: ["audio"],
    audio: {
      input: {
        noise_reduction: { type: "near_field" },
        transcription: { model: "gpt-4o-mini-transcribe" },
        turn_detection: input.mode === "hands_free"
          ? { type: "server_vad", threshold: 0.6, prefix_padding_ms: 300, silence_duration_ms: 650, create_response: true, interrupt_response: true }
          : null,
      },
      output: { voice: input.voice },
    },
    tools: input.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters })),
    tool_choice: "auto",
  };
}
