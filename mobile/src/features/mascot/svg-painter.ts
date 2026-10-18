/**
 * Pure DavePainter that records DAVE's primitives into a reusable pool, for react-native-svg to render.
 * No React Native imports: the root vitest suite unit-tests it (test/mobile-mascot.test.ts).
 */
import type { DavePainter } from "../../../../src/ui/mascot/engine.ts";

export type SvgPrimKind = "dot" | "glow" | "rect" | "line" | "ellipse" | "poly";

/**
 * One recorded primitive. Fields are reused across frames (pooled), so read them during render only.
 * dot/glow: (x, y) centre, a = r. rect: (x, y), a = w, b = h, c = rx. line: (x, y)→(a, b), c = width.
 * ellipse: (x, y), a = rx, b = ry. poly: `points` "x,y x,y ...". `gradient` = glow gradient index.
 */
export type SvgPrim = {
  kind: SvgPrimKind;
  x: number; y: number; a: number; b: number; c: number;
  fill: string; stroke: string; alpha: number; gradient: number; points: string;
};

export type SvgPainter = DavePainter & {
  /** Clear the frame (keeps pooled records). */
  begin(): void;
  /** Recorded primitives this frame are prims[0 .. count). */
  readonly prims: SvgPrim[];
  count(): number;
  /** Glow colours in first-seen order; gradient id for index i is `${idPrefix}${i}`. */
  readonly glowColors: string[];
  /** Painter calls this frame per op, including ones skipped as invisible. */
  readonly calls: Record<"dot" | "glow" | "roundRect" | "line" | "ellipse" | "poly", number>;
};

const INVISIBLE = 0.003;
const round = (n: number) => Math.round(n * 100) / 100;

export function createSvgPainter(): SvgPainter {
  const prims: SvgPrim[] = [];
  const glowColors: string[] = [];
  const glowIndex = new Map<string, number>();
  const calls = { dot: 0, glow: 0, roundRect: 0, line: 0, ellipse: 0, poly: 0 };
  let n = 0;

  const next = (kind: SvgPrimKind): SvgPrim => {
    let p = prims[n];
    if (!p) {
      p = { kind, x: 0, y: 0, a: 0, b: 0, c: 0, fill: "", stroke: "", alpha: 1, gradient: -1, points: "" };
      prims.push(p);
    }
    n++;
    p.kind = kind; p.x = 0; p.y = 0; p.a = 0; p.b = 0; p.c = 0;
    p.fill = ""; p.stroke = ""; p.alpha = 1; p.gradient = -1; p.points = "";
    return p;
  };
  const gradientFor = (color: string): number => {
    const hit = glowIndex.get(color);
    if (hit !== undefined) return hit;
    const i = glowColors.length;
    glowColors.push(color);
    glowIndex.set(color, i);
    return i;
  };

  return {
    prims,
    glowColors,
    calls,
    count: () => n,
    begin() {
      n = 0;
      calls.dot = calls.glow = calls.roundRect = calls.line = calls.ellipse = calls.poly = 0;
    },
    dot(x, y, r, color, alpha = 1) {
      calls.dot++;
      if (alpha <= INVISIBLE || r <= 0) return;
      const p = next("dot");
      p.x = round(x); p.y = round(y); p.a = round(r); p.fill = color; p.alpha = Math.min(1, alpha);
    },
    glow(x, y, r, color, alpha = 1) {
      calls.glow++;
      if (alpha <= INVISIBLE || r <= 0) return;
      const p = next("glow");
      p.x = round(x); p.y = round(y); p.a = round(r); p.fill = color; p.alpha = Math.min(1, alpha);
      p.gradient = gradientFor(color);
    },
    roundRect(x, y, w, h, r, fill, stroke) {
      calls.roundRect++;
      const p = next("rect");
      p.x = round(x); p.y = round(y); p.a = round(w); p.b = round(h); p.c = round(r);
      p.fill = fill ?? ""; p.stroke = stroke ?? "";
    },
    line(x1, y1, x2, y2, color, width) {
      calls.line++;
      const p = next("line");
      p.x = round(x1); p.y = round(y1); p.a = round(x2); p.b = round(y2); p.c = round(width); p.stroke = color;
    },
    ellipse(x, y, rx, ry, color, alpha = 1) {
      calls.ellipse++;
      if (alpha <= INVISIBLE) return;
      const p = next("ellipse");
      p.x = round(x); p.y = round(y); p.a = round(rx); p.b = round(ry); p.fill = color; p.alpha = Math.min(1, alpha);
    },
    poly(points, fill, stroke) {
      calls.poly++;
      if (points.length < 6) return;
      let s = "";
      for (let i = 0; i + 1 < points.length; i += 2) s += `${i ? " " : ""}${round(points[i] ?? 0)},${round(points[i + 1] ?? 0)}`;
      const p = next("poly");
      p.points = s; p.fill = fill; p.stroke = stroke ?? "";
    },
  };
}
