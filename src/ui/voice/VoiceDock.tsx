import { lazy, Suspense, useEffect, useRef } from "react";
import { MOOD_LABEL } from "../mascot/types.ts";
import { isActive, mascotMood } from "./machine.ts";
import { useVoice } from "./VoiceProvider.tsx";
import "./voice.css";

const DaveMascot = lazy(() => import("../mascot/DaveMascot.tsx").then(m => ({ default: m.DaveMascot })));

/** Floating puck on every page; opens the voice panel. The session keeps talking while the panel is closed. */
export function VoiceDock({ hidden = false }: { hidden?: boolean }) {
  const voice = useVoice();
  const ring = useRef<HTMLButtonElement>(null);
  const mood = mascotMood(voice.state);
  const active = isActive(voice.state);
  const { levels } = voice;
  useEffect(() => {
    if (!active || hidden) { ring.current?.style.setProperty("--voice-level", "0"); return; }
    let frame = 0;
    const tick = () => {
      ring.current?.style.setProperty("--voice-level", Math.max(levels.input(), levels.output()).toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, hidden, levels]);
  const approved = active && voice.approval.on;
  return <button ref={ring} type="button" hidden={hidden} className={`voice-dock${active ? " voice-dock-live" : ""}${voice.theme === "light" ? " voice-theme-light" : ""}`} aria-label={active ? `Open voice panel. DAVE is ${MOOD_LABEL[mood]}${approved ? ". Approve all is on" : ""}` : "Talk to DAVE (Alt+Shift+D)"} onClick={voice.openPanel}>
    <Suspense fallback={<span className="voice-dock-dot" aria-hidden="true" />}><DaveMascot mood={mood} size={64} levels={voice.levels} theme={voice.theme} label="" className="voice-dock-mascot" /></Suspense>
    {approved && <span className="voice-dock-badge" title="Approve all is on: DAVE makes changes without asking">Approve all on</span>}
  </button>;
}
