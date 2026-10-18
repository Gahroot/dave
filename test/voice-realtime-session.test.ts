import { describe, expect, it } from "vitest";
import { createRealtimeSession, type FunctionCall, type RealtimeSessionEvents } from "../src/ui/voice/realtime-session.ts";

function setup(greeting = false, extra: RealtimeSessionEvents = {}) {
  const sent: Record<string, unknown>[] = [];
  let handler: (e: unknown) => void = () => undefined;
  const calls: FunctionCall[] = [];
  const log: string[] = [];
  const session = createRealtimeSession({ send: e => sent.push(e), onMessage: h => { handler = h; } }, {
    session: { type: "realtime", instructions: "x" }, greeting,
    events: { onFunctionCall: c => calls.push(c), onReady: () => log.push("ready"), onFatal: c => log.push(`fatal:${c}`), onError: c => log.push(`error:${c}`),
      onTranscript: (r, t) => log.push(`${r}:${t}`), onCaption: (r, t) => log.push(`cap:${r}:${t}`), ...extra },
  });
  const emit = (e: Record<string, unknown>) => handler(JSON.stringify(e));
  const types = () => sent.map(s => s.type);
  return { session, sent, emit, calls, log, types };
}
const ready = (t: ReturnType<typeof setup>) => { t.session.open(); t.emit({ type: "session.updated" }); };

describe("realtime session", () => {
  it("sends session.update on open and becomes ready on session.updated", () => {
    const t = setup();
    t.session.open();
    expect(t.sent[0]).toEqual({ type: "session.update", session: { type: "realtime", instructions: "x" } });
    expect(t.session.ready).toBe(false);
    t.emit({ type: "session.updated" });
    expect(t.session.ready).toBe(true);
    expect(t.log).toContain("ready");
    expect(t.types()).toEqual(["session.update"]);
  });
  it("speaks first with one response.create when greeting", () => {
    const t = setup(true); ready(t);
    t.emit({ type: "session.updated" });
    expect(t.types()).toEqual(["session.update", "response.create"]);
  });
  it("forwards each call once across both events", () => {
    const t = setup(); ready(t);
    t.emit({ type: "response.created" });
    t.emit({ type: "response.function_call_arguments.done", call_id: "c1", name: "focus", arguments: "{\"a\":1}" });
    t.emit({ type: "response.done", response: { output: [{ type: "function_call", call_id: "c1", name: "focus", arguments: "{\"a\":1}" }, { type: "function_call", call_id: "c2", name: "x", arguments: "{}" }] } });
    expect(t.calls).toEqual([{ callId: "c1", name: "focus", args: { a: 1 } }, { callId: "c2", name: "x", args: {} }]);
  });
  it("answers invalid JSON arguments locally", () => {
    const t = setup(); ready(t);
    t.emit({ type: "response.created" });
    t.emit({ type: "response.function_call_arguments.done", call_id: "bad", name: "x", arguments: "{oops" });
    expect(t.calls).toEqual([]);
    const out = t.sent.find(s => s.type === "conversation.item.create") as { item: { type: string; call_id: string; output: string } };
    expect(out.item).toMatchObject({ type: "function_call_output", call_id: "bad" });
    expect(JSON.parse(out.item.output)).toMatchObject({ ok: false });
    expect(t.types()).not.toContain("response.create");
    t.emit({ type: "response.done", response: { output: [] } });
    expect(t.types().filter(x => x === "response.create")).toHaveLength(1);
  });
  it("sends exactly one response.create after several results", () => {
    const t = setup(); ready(t);
    t.emit({ type: "response.created" });
    t.emit({ type: "response.done", response: { output: [1, 2, 3].map(i => ({ type: "function_call", call_id: `c${i}`, name: "n", arguments: "{}" })) } });
    t.session.submitResult("c1", "{\"ok\":true}");
    t.session.submitResult("c2", "{}");
    expect(t.types().filter(x => x === "response.create")).toHaveLength(0);
    t.session.submitResult("c3", "{}");
    t.session.submitResult("c3", "{}");
    expect(t.types().filter(x => x === "conversation.item.create")).toHaveLength(3);
    expect(t.types().filter(x => x === "response.create")).toHaveLength(1);
    expect(t.sent[1]).toEqual({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "c1", output: "{\"ok\":true}" } });
  });
  it("waits for an open response to finish before responding to results", () => {
    const t = setup(); ready(t);
    t.emit({ type: "response.created" });
    t.emit({ type: "response.function_call_arguments.done", call_id: "c1", name: "n", arguments: "{}" });
    t.session.submitResult("c1", "{}");
    expect(t.types()).not.toContain("response.create");
    t.emit({ type: "response.done", response: { output: [{ type: "function_call", call_id: "c1", name: "n", arguments: "{}" }] } });
    expect(t.types().filter(x => x === "response.create")).toHaveLength(1);
  });
  it("notify waits for a quiet moment and batches notes", () => {
    const t = setup(); ready(t);
    t.emit({ type: "input_audio_buffer.speech_started" });
    t.session.notify("[Context] a");
    t.emit({ type: "input_audio_buffer.speech_stopped" });
    // still quiet? yes -> flushed now
    expect(t.session.queuedNotes).toBe(0);
    t.emit({ type: "output_audio_buffer.started" });
    t.session.notify("[Context] b");
    t.session.notify("[Update] c");
    expect(t.types().filter(x => x === "conversation.item.create")).toHaveLength(1);
    t.emit({ type: "output_audio_buffer.stopped" });
    const items = t.sent.filter(s => s.type === "conversation.item.create") as { item: { role: string; content: { type: string; text: string }[] } }[];
    expect(items).toHaveLength(2);
    expect(items[1]?.item.role).toBe("system");
    expect(items[1]?.item.content).toEqual([{ type: "input_text", text: "[Context] b\n[Update] c" }]);
    expect(t.types()).not.toContain("response.create");
  });
  it("notify holds notes while a call is pending and responds for [Shared]", () => {
    const t = setup(); ready(t);
    t.emit({ type: "response.created" });
    t.emit({ type: "response.done", response: { output: [{ type: "function_call", call_id: "c1", name: "n", arguments: "{}" }] } });
    t.session.notify("[Shared] file");
    expect(t.session.queuedNotes).toBe(1);
    t.session.submitResult("c1", "{}");
    expect(t.types().filter(x => x === "response.create")).toHaveLength(1);
    t.emit({ type: "response.created" });
    t.emit({ type: "response.done", response: { output: [] } });
    expect(t.session.queuedNotes).toBe(0);
    expect(t.types().slice(-2)).toEqual(["conversation.item.create", "response.create"]);
  });
  it("push-to-talk clears on press and commits plus responds on release", () => {
    const t = setup(); ready(t);
    t.session.pushToTalk("down");
    t.session.pushToTalk("up");
    expect(t.types().slice(1)).toEqual(["input_audio_buffer.clear", "input_audio_buffer.commit", "response.create"]);
  });
  it("sendText and sendImage item shapes", () => {
    const t = setup(); ready(t);
    t.session.sendText(" hi ");
    t.emit({ type: "response.created" }); t.emit({ type: "response.done", response: {} });
    t.session.sendImage("data:image/jpeg;base64,AAA");
    expect(t.sent[1]).toEqual({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } });
    expect(t.sent[2]).toEqual({ type: "response.create" });
    expect(t.sent[3]).toEqual({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/jpeg;base64,AAA" }] } });
    expect(t.sent).toHaveLength(4);
  });
  it("captions and final transcripts", () => {
    const t = setup(); ready(t);
    t.emit({ type: "response.output_audio_transcript.delta", delta: "Hel" });
    t.emit({ type: "response.output_audio_transcript.delta", delta: "lo" });
    t.emit({ type: "response.output_audio_transcript.done", transcript: "Hello" });
    t.emit({ type: "conversation.item.input_audio_transcription.delta", delta: "yo" });
    t.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "yo there" });
    expect(t.log.filter(l => !l.startsWith("ready"))).toEqual(["cap:assistant:Hel", "cap:assistant:Hello", "cap:assistant:", "assistant:Hello", "cap:user:yo", "cap:user:", "user:yo there"]);
  });
  it("ignores benign errors and stops on fatal ones", () => {
    const t = setup(); ready(t);
    t.emit({ type: "error", error: { code: "response_cancel_not_active" } });
    t.emit({ type: "error", error: { code: "conversation_already_has_active_response" } });
    t.emit({ type: "error", error: { code: "something_else", message: "m" } });
    expect(t.log).toEqual(["ready", "error:something_else"]);
    t.emit({ type: "error", error: { code: "session_expired" } });
    expect(t.log).toContain("fatal:session_expired");
    const before = t.sent.length;
    t.session.sendText("x");
    expect(t.sent.length).toBe(before);
  });
  it("treats a data channel close as fatal once", () => {
    const t = setup(); ready(t);
    t.session.handleClose(); t.session.handleClose();
    expect(t.log.filter(l => l.startsWith("fatal"))).toEqual(["fatal:closed"]);
  });
});
