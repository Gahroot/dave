// Native port of src/ui/mascot/DaveMascot.tsx: the shared pure engine painted through react-native-svg.
import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";
import { AccessibilityInfo, AppState, View } from "react-native";
import Svg, { Circle, Defs, Ellipse, Line, Polygon, RadialGradient, Rect, Stop } from "react-native-svg";
import { createDaveBody, DAVE_LOD_PX, paintDave, paintStaticDave, stepDave, type DaveBody } from "../../../../src/ui/mascot/engine.ts";
import { DAVE_PALETTE } from "../../../../src/ui/mascot/palette.ts";
import { MOOD_LABEL, type DaveLevels, type DaveMood } from "../../../../src/ui/mascot/types.ts";
import { createSvgPainter, type SvgPainter, type SvgPrim } from "./svg-painter.ts";

const SEED = 0xda7e;
/** Longest step fed to the springs (s); longer gaps (jank, resume) are clamped. */
const MAX_DT = 1 / 20;
/** At or above this size each frame is ~300 SVG nodes; cap at ~30 fps. */
const THROTTLE_PX = 120;
const THROTTLE_MS = 1000 / 30 - 4;

function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (alive) setReduce(v); }, () => undefined);
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", (v: boolean) => setReduce(v));
    return () => { alive = false; sub.remove(); };
  }, []);
  return reduce;
}

function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setActive(s === "active"));
    return () => sub.remove();
  }, []);
  return active;
}

function renderPrim(p: SvgPrim, i: number, idPrefix: string): ReactElement | null {
  switch (p.kind) {
    case "dot":
      return <Circle key={i} cx={p.x} cy={p.y} r={p.a} fill={p.fill} fillOpacity={p.alpha} />;
    case "glow":
      return <Circle key={i} cx={p.x} cy={p.y} r={p.a} fill={`url(#${idPrefix}${p.gradient})`} opacity={p.alpha} />;
    case "rect":
      return <Rect key={i} x={p.x} y={p.y} width={p.a} height={p.b} rx={p.c} fill={p.fill || "none"} stroke={p.stroke || undefined} strokeWidth={p.stroke ? 1 : 0} />;
    case "line":
      return <Line key={i} x1={p.x} y1={p.y} x2={p.a} y2={p.b} stroke={p.stroke} strokeWidth={p.c} strokeLinecap="round" />;
    case "ellipse":
      return <Ellipse key={i} cx={p.x} cy={p.y} rx={p.a} ry={p.b} fill={p.fill} fillOpacity={p.alpha} />;
    case "poly":
      return <Polygon key={i} points={p.points} fill={p.fill} stroke={p.stroke || undefined} strokeWidth={p.stroke ? 1 : 0} />;
  }
}

/**
 * The DAVE bot: animated LED robot face. Static single frame under OS reduce-motion or below the
 * engine's LOD size. The loop stops when the app is backgrounded, `visible` is false, or on unmount.
 */
export function DaveMascot({ mood, size, levels, label, visible = true, onFrameStats }: {
  mood: DaveMood;
  size: number;
  levels?: DaveLevels;
  label?: string;
  /** Pass false when off-screen (e.g. screen not focused, scrolled away) to stop the loop. */
  visible?: boolean;
  /** Dev perf hook: primitives recorded in the frame just painted. */
  onFrameStats?: (primitives: number) => void;
}) {
  const reduceMotion = useReduceMotion();
  const appActive = useAppActive();
  const painter = useRef<SvgPainter | null>(null);
  painter.current ??= createSvgPainter();
  const body = useRef<DaveBody | null>(null);
  const live = useRef({ mood, levels, size, onFrameStats });
  live.current = { mood, levels, size, onFrameStats };
  const [frame, setFrame] = useState(0);
  const idPrefix = `daveglow${useId().replace(/[^a-zA-Z0-9]/g, "")}_`;
  const isStatic = reduceMotion || size < DAVE_LOD_PX;
  const running = !isStatic && appActive && visible;

  // Static frame: paint once per mood/size.
  useEffect(() => {
    const p = painter.current;
    if (!isStatic || !p) return;
    p.begin();
    paintStaticDave(mood, p, DAVE_PALETTE, size, SEED);
    live.current.onFrameStats?.(p.count());
    setFrame((f) => f + 1);
  }, [isStatic, mood, size]);

  // Animation loop.
  useEffect(() => {
    const p = painter.current;
    if (!running || !p) return;
    const b = body.current ?? createDaveBody(SEED);
    body.current = b;
    let raf = 0;
    let last = 0;
    let lastPaint = 0;
    const tick = (now: number) => {
      const l = live.current;
      if (last && l.size >= THROTTLE_PX && now - lastPaint < THROTTLE_MS) { raf = requestAnimationFrame(tick); return; }
      const dt = last ? Math.min(MAX_DT, Math.max(0, (now - last) / 1000)) : 0;
      last = now;
      lastPaint = now;
      const lv = l.levels;
      stepDave(b, dt, { mood: l.mood, input: lv ? lv.input() : 0, output: lv ? lv.output() : 0 });
      p.begin();
      paintDave(b, b.time, p, DAVE_PALETTE, l.size);
      l.onFrameStats?.(p.count());
      setFrame((f) => (f + 1) % 1_000_000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running]);

  const p = painter.current;
  const glowKey = p.glowColors.join("|");
  const defs = useMemo(
    () => (
      <Defs>
        {glowKey.split("|").filter(Boolean).map((color, i) => (
          <RadialGradient key={color} id={`${idPrefix}${i}`} cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={color} stopOpacity={1} />
            <Stop offset="1" stopColor={color} stopOpacity={0} />
          </RadialGradient>
        ))}
      </Defs>
    ),
    [glowKey, idPrefix],
  );

  const nodes: (ReactElement | null)[] = [];
  const count = frame >= 0 ? p.count() : 0;
  for (let i = 0; i < count; i++) {
    const prim = p.prims[i];
    if (prim) nodes.push(renderPrim(prim, i, idPrefix));
  }

  const decorative = label === "";
  return (
    <View
      style={{ width: size, height: size }}
      accessible={!decorative}
      accessibilityRole={decorative ? undefined : "image"}
      accessibilityLabel={decorative ? undefined : (label ?? `DAVE is ${MOOD_LABEL[mood]}`)}
      accessibilityElementsHidden={decorative}
      importantForAccessibility={decorative ? "no-hide-descendants" : "yes"}
    >
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} pointerEvents="none">
        {defs}
        {nodes}
      </Svg>
    </View>
  );
}
