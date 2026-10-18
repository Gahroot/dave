import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createDaveBody, paintDave, paintStaticDave, stepDave, type DaveBody } from "./engine.ts";
import { DAVE_FORCED_PALETTE, DAVE_PALETTE } from "./palette.ts";
import { createCanvasPainter } from "./paint-canvas.ts";
import { MOOD_LABEL, type DaveMascotProps } from "./types.ts";
import "./mascot.css";

const SEED = 0xda7e;
const LOOK_RANGE_PX = 360;
const POINTER_THROTTLE_MS = 33;
/** Pointer travel (px) below which a press is a poke, not a drag. */
const DRAG_SLOP_PX = 4;

function query(q: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(q).matches;
}

/** The DAVE bot: an animated LED robot face on a canvas. */
export function DaveMascot({ mood, size, levels, onPoke, label, className }: DaveMascotProps) {
  const wrapRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const live = useRef({ mood, levels, size, poke: false, look: { x: 0, y: 0 }, spin: 0, dragging: false });
  const drag = useRef<{ id: number; x0: number; y0: number; last: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  live.current.mood = mood;
  live.current.levels = levels;
  live.current.size = size;
  const [reducedMotion, setReducedMotion] = useState(() => query("(prefers-reduced-motion: reduce)"));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReducedMotion(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const paintKey = reducedMotion ? `static:${mood}:${size}` : "live";
  const bodyRef = useRef<DaveBody | null>(null);

  // Animation loop (or one static frame per mood under reduced motion).
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const painter = createCanvasPainter(canvas);
    if (!painter) return;
    const palette = () => (query("(forced-colors: active)") ? DAVE_FORCED_PALETTE : DAVE_PALETTE);
    const dpr = () => (typeof window.devicePixelRatio === "number" ? window.devicePixelRatio : 1);

    if (reducedMotion) {
      painter.begin(size, dpr());
      paintStaticDave(mood, painter, palette(), size, SEED);
      return;
    }

    const body = bodyRef.current ?? createDaveBody(SEED);
    bodyRef.current = body;
    let raf = 0;
    let last = 0;
    let onScreen = true;
    const visible = () => onScreen && document.visibilityState !== "hidden";
    const frame = (now: number) => {
      raf = 0;
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      const l = live.current;
      const lv = l.levels;
      stepDave(body, dt, { mood: l.mood, look: l.look, input: lv ? lv.input() : 0, output: lv ? lv.output() : 0, poke: l.poke, spin: l.spin, dragging: l.dragging });
      l.poke = false;
      l.spin = 0;
      painter.begin(l.size, dpr());
      paintDave(body, body.time, painter, palette(), l.size);
      schedule();
    };
    const schedule = () => { if (!raf && visible()) raf = requestAnimationFrame(frame); };
    const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; last = 0; };
    const onVis = () => (visible() ? schedule() : stop());
    document.addEventListener("visibilitychange", onVis);
    const io = typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => { for (const e of entries) onScreen = e.isIntersecting; onVis(); })
      : null;
    io?.observe(wrap);

    let lastMove = 0;
    const onMove = (e: PointerEvent) => {
      if (e.timeStamp - lastMove < POINTER_THROTTLE_MS) return;
      lastMove = e.timeStamp;
      const r = wrap.getBoundingClientRect();
      const clamp = (n: number) => Math.max(-1, Math.min(1, n));
      live.current.look = { x: clamp((e.clientX - (r.left + r.width / 2)) / LOOK_RANGE_PX), y: clamp((e.clientY - (r.top + r.height / 2)) / LOOK_RANGE_PX) };
    };
    const onLeave = () => { live.current.look = { x: 0, y: 0 }; };
    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    schedule();
    return () => {
      stop();
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
    };
    // Animated mode reads mood/size from `live`; the static frame repaints when paintKey changes.
  }, [paintKey]);

  const poke = () => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    live.current.poke = true;
    onPoke?.();
  };
  // Drag to spin: horizontal travel turns the head (half a turn per widget width); release keeps the
  // inertia and the engine springs DAVE back to facing forward. A press that moves < 4 px stays a click.
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (reducedMotion || (e.pointerType === "mouse" && e.button !== 0)) return;
    drag.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, last: e.clientX, moved: false };
    suppressClick.current = false;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) >= DRAG_SLOP_PX) { d.moved = true; live.current.dragging = true; }
    if (!d.moved) return;
    live.current.spin += ((e.clientX - d.last) / Math.max(1, size)) * Math.PI;
    d.last = e.clientX;
  };
  const endDrag = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    live.current.dragging = false;
    if (d.moved) suppressClick.current = true;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const pointer = { onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag };
  const name = label ?? `DAVE is ${MOOD_LABEL[mood]}`;
  const cls = ["dave-mascot", onPoke ? "dave-mascot--button" : "", className ?? ""].filter(Boolean).join(" ");
  const canvas = <canvas ref={canvasRef} className="dave-mascot__canvas" aria-hidden="true" style={{ width: size, height: size }} />;

  if (onPoke) {
    return (
      <button type="button" ref={(el) => { wrapRef.current = el; }} className={cls} aria-label={name} data-mood={mood}
        style={{ width: size, height: size }} onClick={poke} {...pointer}>
        {canvas}
      </button>
    );
  }
  return (
    <div ref={(el) => { wrapRef.current = el; }} role="img" aria-label={name} className={cls} data-mood={mood}
      style={{ width: size, height: size }} {...pointer}
      onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } live.current.poke = true; }}>
      {canvas}
    </div>
  );
}
