/** Start/stop chimes from WebAudio oscillators. Silent when sounds are off or the user prefers reduced motion. */
export type Chime = "start" | "stop";

const NOTES: Record<Chime, readonly number[]> = { start: [523.25, 783.99], stop: [659.25, 392] };

export function playChime(kind: Chime, enabled: boolean): void {
  if (!enabled || typeof window === "undefined" || typeof AudioContext === "undefined") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  let context: AudioContext;
  try { context = new AudioContext(); } catch { return; }
  const now = context.currentTime;
  NOTES[kind].forEach((frequency, index) => {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = "sine";
    osc.frequency.value = frequency;
    const t = now + index * 0.12;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    osc.connect(gain).connect(context.destination);
    osc.start(t);
    osc.stop(t + 0.25);
  });
  window.setTimeout(() => { void context.close().catch(() => undefined); }, 800);
}
