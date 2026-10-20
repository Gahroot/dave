import { describe, expect, it } from "vitest";
import { createSvgPainter } from "../mobile/src/features/mascot/svg-painter.ts";
import { DAVE_LOD_PX, paintStaticDave, type DavePainter } from "../src/ui/mascot/engine.ts";
import { DAVE_PALETTE } from "../src/ui/mascot/palette.ts";
import { DAVE_MOODS } from "../src/ui/mascot/types.ts";

type Op = "dot" | "glow" | "roundRect" | "line" | "ellipse" | "poly";
function counter(): DavePainter & { n: Record<Op, number> } {
  const n: Record<Op, number> = { dot: 0, glow: 0, roundRect: 0, line: 0, ellipse: 0, poly: 0 };
  return { n, dot: () => { n.dot++; }, glow: () => { n.glow++; }, roundRect: () => { n.roundRect++; }, line: () => { n.line++; }, ellipse: () => { n.ellipse++; }, poly: () => { n.poly++; } };
}
const snapshot = (p: ReturnType<typeof createSvgPainter>) => JSON.stringify(p.prims.slice(0, p.count()));

describe("mobile DAVE svg painter", () => {
  for (const size of [180, 48]) {
    it(`records every static mood consistently with paintStaticDave stats (size ${size})`, () => {
      const p = createSvgPainter();
      for (const mood of DAVE_MOODS) {
        p.begin();
        const stats = paintStaticDave(mood, p, DAVE_PALETTE, size, 7);
        const ref = counter();
        const refStats = paintStaticDave(mood, ref, DAVE_PALETTE, size, 7);
        expect(stats, mood).toEqual(refStats);
        expect(p.calls, mood).toEqual(ref.n);
        expect(stats.lod, mood).toBe(size < DAVE_LOD_PX);
        // Every painted head dot is at least one dot call; recorded prims never exceed calls.
        expect(p.calls.dot, mood).toBeGreaterThanOrEqual(stats.front + stats.side + stats.back + stats.ear);
        const total = Object.values(p.calls).reduce((a, b) => a + b, 0);
        expect(p.count(), mood).toBeLessThanOrEqual(total);
        expect(p.prims.slice(0, p.count()).filter((x) => x.kind === "dot").length, mood).toBeGreaterThan(stats.front / 2);
        if (stats.lod) expect(stats.ear + stats.side + stats.back, mood).toBe(0);
        for (const g of p.prims.slice(0, p.count()).filter((x) => x.kind === "glow")) expect(p.glowColors[g.gradient]).toBe(g.fill);
      }
    });
  }

  it("is deterministic for a fixed seed and reuses its pool", () => {
    for (const mood of DAVE_MOODS) {
      const a = createSvgPainter();
      const b = createSvgPainter();
      paintStaticDave(mood, a, DAVE_PALETTE, 160, 42);
      paintStaticDave(mood, b, DAVE_PALETTE, 160, 42);
      expect(snapshot(a), mood).toBe(snapshot(b));
      const first = a.prims[0];
      const once = snapshot(a);
      a.begin();
      paintStaticDave(mood, a, DAVE_PALETTE, 160, 42);
      expect(snapshot(a), mood).toBe(once);
      expect(a.prims[0], mood).toBe(first);
    }
  });
});
