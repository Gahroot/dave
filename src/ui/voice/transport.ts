/** Browser WebRTC transport for OpenAI Realtime (GA). Every browser API is injected so callers and tests can swap them. */
import type { DaveLevels } from "../mascot/types.ts";
import type { RealtimeChannel } from "./realtime-session.ts";

export const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

export type TransportDeps = {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createPeer: () => RTCPeerConnection;
  createAudio: () => HTMLAudioElement;
  createAudioContext: () => AudioContext | null;
  fetch: typeof fetch;
};

export function browserTransportDeps(): TransportDeps | null {
  if (typeof window === "undefined" || typeof RTCPeerConnection === "undefined" || !navigator.mediaDevices?.getUserMedia) return null;
  return {
    getUserMedia: c => navigator.mediaDevices.getUserMedia(c),
    createPeer: () => new RTCPeerConnection(),
    createAudio: () => { const a = document.createElement("audio"); a.autoplay = true; return a; },
    createAudioContext: () => typeof AudioContext === "undefined" ? null : new AudioContext(),
    fetch: (...args) => window.fetch(...args),
  };
}

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
  /** Push-to-talk gate: the mic track only carries audio while open. */
  setGateOpen: (open: boolean) => void;
  close: () => void;
};

export class TransportError extends Error {
  code: "mic_denied" | "unsupported" | "sdp_failed" | "aborted";
  constructor(code: TransportError["code"], message: string) { super(message); this.code = code; }
}

/** RMS of the analyser's time-domain samples, 0..1. */
export function rms(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) { const v = ((samples[i] ?? 128) - 128) / 128; sum += v * v; }
  return Math.min(1, Math.sqrt(sum / samples.length));
}

function meter(context: AudioContext | null, stream: MediaStream): () => number {
  if (!context) return () => 0;
  try {
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    return () => { analyser.getByteTimeDomainData(data); return rms(data); };
  } catch { return () => 0; }
}

export async function connectTransport(deps: TransportDeps, options: ConnectOptions): Promise<Transport> {
  let mic: MediaStream;
  try {
    mic = await deps.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch {
    throw new TransportError("mic_denied", "DAVE cannot hear you: allow microphone access for this page, then try again.");
  }
  const peer = deps.createPeer();
  const audio = deps.createAudio();
  const context = deps.createAudioContext();
  const handlers: ((event: unknown) => void)[] = [];
  let outputLevel: () => number = () => 0;
  let muted = false;
  let gateOpen = !options.gated;
  let closed = false;
  const track = mic.getAudioTracks()[0];
  const applyTrack = () => { if (track) track.enabled = !muted && gateOpen; };
  applyTrack();

  const close = () => {
    if (closed) return;
    closed = true;
    for (const t of mic.getTracks()) t.stop();
    for (const sender of peer.getSenders()) sender.track?.stop();
    try { channel.close(); } catch { /* already closed */ }
    peer.close();
    audio.srcObject = null;
    void context?.close().catch(() => undefined);
  };

  peer.ontrack = (event) => {
    const stream = event.streams[0] ?? new MediaStream([event.track]);
    audio.srcObject = stream;
    void audio.play?.()?.catch(() => undefined);
    outputLevel = meter(context, stream);
  };
  // The mic track must be on the peer before the offer so the SDP carries an audio m-line.
  if (track) peer.addTrack(track, mic);
  const channel = peer.createDataChannel("oai-events");
  channel.addEventListener("message", (event: MessageEvent) => { for (const h of handlers) h(event.data); });
  channel.addEventListener("open", () => { if (!closed) options.onOpen(); });
  channel.addEventListener("close", () => { if (!closed) options.onClose(); });
  const inputLevel = meter(context, mic);

  try {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const response = await deps.fetch(REALTIME_CALLS_URL, {
      method: "POST", body: offer.sdp ?? "", signal: options.signal,
      headers: { Authorization: `Bearer ${options.secret}`, "Content-Type": "application/sdp" },
    });
    if (!response.ok) throw new TransportError("sdp_failed", `OpenAI did not accept the voice connection (${response.status}). Try again.`);
    await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
  } catch (e) {
    close();
    if (e instanceof TransportError) throw e;
    if (options.signal.aborted) throw new TransportError("aborted", "Voice start was cancelled.");
    throw new TransportError("sdp_failed", "Could not reach OpenAI for voice. Check your connection and try again.");
  }

  return {
    channel: {
      send: (event) => { if (!closed && channel.readyState === "open") channel.send(JSON.stringify(event)); },
      onMessage: (handler) => { handlers.push(handler); },
    },
    levels: { input: () => (closed || muted || !gateOpen ? 0 : inputLevel()), output: () => (closed ? 0 : outputLevel()) },
    setMuted: (next) => { muted = next; applyTrack(); },
    setGateOpen: (next) => { gateOpen = next; applyTrack(); },
    close,
  };
}
