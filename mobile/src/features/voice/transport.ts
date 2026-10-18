/**
 * Native WebRTC transport for OpenAI Realtime (GA): the phone's port of
 * src/ui/voice/transport.ts on react-native-webrtc.
 *
 * The SDP offer goes straight from the phone to OpenAI with the short-lived
 * client secret the Mac minted (POST /api/voice/sessions); the ChatGPT token
 * never leaves the Mac. Remote audio plays natively (no <audio> element).
 * Levels come from getStats() audioLevel polled at ~10 Hz, because
 * react-native-webrtc has no WebAudio analyser.
 */
import { Platform } from "react-native";
import { mediaDevices, RTCPeerConnection, type MediaStream } from "react-native-webrtc";
import { requestRecordingPermissionsAsync, setAudioModeAsync } from "expo-audio";
import type { DaveLevels } from "../../../../src/ui/mascot/types.ts";
import type { RealtimeChannel } from "../../../../src/ui/voice/realtime-session.ts";
import { levelsFromStats, MIC_DENIED_MESSAGE, type AudioLevels } from "./model";

export const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const SDP_TIMEOUT_MS = 20_000;
const LEVEL_POLL_MS = 100;
// Echo cancellation, noise suppression and gain control are on by default in the native WebRTC audio stack
// (react-native-webrtc's audio constraints carry no such flags).

export type ConnectOptions = {
  secret: string;
  signal: AbortSignal;
  onOpen: () => void;
  onClose: () => void;
  /** Start with the mic closed (push-to-talk). */
  gated: boolean;
};

export type Transport = {
  channel: RealtimeChannel;
  levels: DaveLevels;
  setMuted: (muted: boolean) => void;
  setGateOpen: (open: boolean) => void;
  close: () => void;
};

export class TransportError extends Error {
  code: "mic_denied" | "unsupported" | "sdp_failed" | "aborted";
  /** The OS can still show its prompt (false: only Settings can grant it). */
  canAskAgain: boolean;
  constructor(code: TransportError["code"], message: string, canAskAgain = true) { super(message); this.code = code; this.canAskAgain = canAskAgain; }
}

/**
 * Loudspeaker, not earpiece: PlayAndRecord with defaultToSpeaker on iOS
 * (expo-audio maps shouldRouteThroughEarpiece: false to that option).
 */
async function speakerMode(): Promise<void> {
  await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true, shouldRouteThroughEarpiece: false, interruptionMode: "doNotMix" }).catch(() => undefined);
}
async function idleMode(): Promise<void> {
  await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false, shouldRouteThroughEarpiece: false, interruptionMode: "mixWithOthers" }).catch(() => undefined);
}

export async function connectTransport(options: ConnectOptions): Promise<Transport> {
  const permission = await requestRecordingPermissionsAsync().catch(() => null);
  if (!permission?.granted) throw new TransportError("mic_denied", MIC_DENIED_MESSAGE, permission?.canAskAgain ?? true);
  await speakerMode();
  let mic: MediaStream;
  try {
    mic = await mediaDevices.getUserMedia({ audio: true, video: false });
  } catch {
    void idleMode();
    throw new TransportError("mic_denied", MIC_DENIED_MESSAGE);
  }
  const peer = new RTCPeerConnection();
  const handlers: ((event: unknown) => void)[] = [];
  let muted = false;
  let gateOpen = !options.gated;
  let closed = false;
  let latest: AudioLevels = { input: 0, output: 0 };
  const track = mic.getAudioTracks()[0];
  const applyTrack = () => { if (track) track.enabled = !muted && gateOpen; };
  applyTrack();

  let polling = false;
  const timer = setInterval(() => {
    if (closed || polling) return;
    polling = true;
    peer.getStats().then((report: unknown) => {
      if (!closed && report instanceof Map) latest = levelsFromStats(report.values());
    }, () => undefined).finally(() => { polling = false; });
  }, LEVEL_POLL_MS);

  // The mic track must be on the peer before the offer so the SDP carries an audio m-line.
  if (track) peer.addTrack(track, mic);
  const channel = peer.createDataChannel("oai-events");

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    for (const t of mic.getTracks()) t.stop();
    try { channel.close(); } catch { /* already closed */ }
    try { peer.close(); } catch { /* already closed */ }
    try { mic.release(); } catch { /* already released */ }
    latest = { input: 0, output: 0 };
    void idleMode();
  };

  // WebRTC's own audio session setup can reset the route when the remote track starts; reassert the speaker.
  peer.addEventListener("track", () => { if (!closed && Platform.OS === "ios") void speakerMode(); });
  channel.addEventListener("message", (event) => { const data: unknown = event.data; for (const h of handlers) h(data); });
  channel.addEventListener("open", () => { if (!closed) { if (Platform.OS === "ios") void speakerMode(); options.onOpen(); } });
  channel.addEventListener("close", () => { if (!closed) options.onClose(); });

  const timeout = new AbortController();
  const timeoutId = setTimeout(() => timeout.abort(), SDP_TIMEOUT_MS);
  const onAbort = () => timeout.abort();
  options.signal.addEventListener("abort", onAbort);
  try {
    const offer = await peer.createOffer({});
    await peer.setLocalDescription(offer);
    const sdp: string = typeof offer?.sdp === "string" ? offer.sdp : "";
    const response = await fetch(REALTIME_CALLS_URL, {
      method: "POST", body: sdp, signal: timeout.signal,
      headers: { Authorization: `Bearer ${options.secret}`, "Content-Type": "application/sdp" },
    });
    if (!response.ok) throw new TransportError("sdp_failed", `OpenAI did not accept the voice connection (${response.status}). Try again.`);
    await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
  } catch (e) {
    close();
    if (e instanceof TransportError) throw e;
    if (options.signal.aborted) throw new TransportError("aborted", "Voice start was cancelled.");
    throw new TransportError("sdp_failed", "Could not reach OpenAI for voice. Check your connection and try again.");
  } finally {
    clearTimeout(timeoutId);
    options.signal.removeEventListener("abort", onAbort);
  }

  return {
    channel: {
      send: (event) => { if (!closed && channel.readyState === "open") channel.send(JSON.stringify(event)); },
      onMessage: (handler) => { handlers.push(handler); },
    },
    levels: { input: () => (closed || muted || !gateOpen ? 0 : latest.input), output: () => (closed ? 0 : latest.output) },
    setMuted: (next) => { muted = next; applyTrack(); },
    setGateOpen: (next) => { gateOpen = next; applyTrack(); },
    close,
  };
}
