import { describe, expect, it } from "vitest";
import { createDaveBody, DAVE_LOD_PX, daveEnergy, eyeOpenness, mouthLevel, paintDave, paintStaticDave, projectFront, stepDave, type DaveBody, type DavePainter, type DaveStepInput } from "../src/ui/mascot/engine.ts";
import { FONT_5X7, GLYPH_H, GLYPH_W, glyphFor, layoutLedText } from "../src/ui/mascot/font5x7.ts";
import { contrast, DAVE_PALETTE } from "../src/ui/mascot/palette.ts";
import { DAVE_MOODS } from "../src/ui/mascot/types.ts";

type Call = { op: string; args: (number | string | undefined)[] };
function recorder(): DavePainter & { calls: Call[] } {
  const calls: Call[] = [];
  const rec = (op: string) => (...args: (number | string | undefined)[]) => { calls.push({ op, args }); };
  return { calls, dot: rec("dot"), glow: rec("glow"), roundRect: rec("roundRect"), line: rec("line"), ellipse: rec("ellipse") };
}
const LIT = new Set([DAVE_PALETTE.lit, DAVE_PALETTE.light, DAVE_PALETTE.oops]);
const litDots = (calls: Call[]) => calls.filter((c) => c.op === "dot" && LIT.has(String(c.args[3])) && Number(c.args[4] ?? 1) > 0.5);

function run(body: DaveBody, seconds: number, input: DaveStepInput | ((t: number) => DaveStepInput), dt = 1 / 60): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) stepDave(body, dt, typeof input === "function" ? input(body.time) : input);
}

describe("DAVE bot engine", () => {
  it("is deterministic for the same seed and steps", () => {
    const log = () => {
      const b = createDaveBody(42);
      const p = recorder();
      run(b, 3, (t) => ({ mood: t < 1 ? "idle" : "speaking", output: 0.2, look: { x: 0.4, y: -0.2 }, poke: t > 1.5 && t < 1.52 }));
      paintDave(b, b.time, p, DAVE_PALETTE, 180);
      return JSON.stringify(p.calls);
    };
    expect(log()).toBe(log());
  });

  it("paints every mood with lit dots", () => {
    for (const mood of DAVE_MOODS) {
      const b = createDaveBody(3);
      const p = recorder();
      run(b, 1, { mood, input: 0.3, output: 0.3 });
      expect(() => paintDave(b, b.time, p, DAVE_PALETTE, 64)).not.toThrow();
      expect(litDots(p.calls).length, mood).toBeGreaterThan(4);
    }
  });

  it("scales the mouth with output level while speaking", () => {
    const level = (out: number) => { const b = createDaveBody(5); run(b, 1, { mood: "speaking", output: out }); return mouthLevel(b); };
    const quiet = level(0.01);
    const loud = level(0.3);
    expect(loud).toBeGreaterThan(quiet * 2);
    const b = createDaveBody(5);
    run(b, 1, { mood: "idle", output: 0.3 });
    expect(mouthLevel(b)).toBeCloseTo(0.3, 2);
  });

  it("blinks within 10 s but not constantly", () => {
    const b = createDaveBody(9);
    let closed = 0;
    let frames = 0;
    for (let i = 0; i < 600; i++) { stepDave(b, 1 / 60, { mood: "idle" }); frames++; if (eyeOpenness(b) < 0.5) closed++; }
    expect(closed).toBeGreaterThan(0);
    expect(closed / frames).toBeLessThan(0.15);
  });

  it("settles the poke spring within about 2 s", () => {
    const b = createDaveBody(11);
    run(b, 0.5, { mood: "idle" });
    stepDave(b, 1 / 60, { mood: "idle", poke: true });
    run(b, 0.1, { mood: "idle" });
    expect(daveEnergy(b)).toBeGreaterThan(0.05);
    run(b, 2, { mood: "idle" });
    expect(daveEnergy(b)).toBeLessThan(0.02);
  });

  it("paints a stable static frame", () => {
    for (const mood of DAVE_MOODS) {
      const a = recorder();
      const c = recorder();
      paintStaticDave(mood, a, DAVE_PALETTE, 180);
      paintStaticDave(mood, c, DAVE_PALETTE, 180);
      expect(JSON.stringify(a.calls)).toBe(JSON.stringify(c.calls));
      expect(litDots(a.calls).length).toBeGreaterThan(4);
    }
    const b = createDaveBody(1);
    run(b, 1, { mood: "thinking" });
    const x = recorder();
    const y = recorder();
    paintDave(b, 2, x, DAVE_PALETTE, 120);
    paintDave(b, 2, y, DAVE_PALETTE, 120);
    expect(x.calls).toEqual(y.calls);
  });
});

describe("DAVE bot 3D", () => {
  const centreIndex = (b: DaveBody) => {
    let best = 0;
    b.dots.forEach((d, i) => { const cur = b.dots[best]; if (cur && Math.abs(d.u) + Math.abs(d.v) < Math.abs(cur.u) + Math.abs(cur.v)) best = i; });
    return best;
  };

  it("faces the camera with the front centre at yaw 0", () => {
    const b = createDaveBody(1);
    stepDave(b, 0, { mood: "listening" });
    const p = projectFront(b, 0, 180)[centreIndex(b)];
    expect(p?.facing).toBeGreaterThan(0.99);
    expect(Math.abs((p?.x ?? 0) - 90)).toBeLessThan(180 * 0.03);
  });

  it("culls the back and draws the side band and ears only when turned", () => {
    const b = createDaveBody(1);
    stepDave(b, 0, { mood: "listening" });
    const front = paintDave(b, 0, recorder(), DAVE_PALETTE, 180);
    expect(front.back).toBe(0);
    expect(front.culled).toBeGreaterThan(100);
    expect(front.front).toBe(b.dots.length);
    b.spin.yaw = Math.PI;
    const back = paintDave(b, 0, recorder(), DAVE_PALETTE, 180);
    expect(back.back).toBeGreaterThan(100);
    expect(back.front).toBe(0);
  });

  it("moves the front centre on screen with yaw", () => {
    const b = createDaveBody(1);
    stepDave(b, 0, { mood: "listening" });
    const i = centreIndex(b);
    const x0 = projectFront(b, 0, 180)[i]?.x ?? 0;
    b.spin.yaw = 0.6;
    const p = projectFront(b, 0, 180)[i];
    expect((p?.x ?? 0) - x0).toBeGreaterThan(10);
    expect(p?.facing).toBeLessThan(0.95);
  });

  it("never paints NaN in any mood, with spin", () => {
    // Collect offenders and assert once: an expect() per painted number made this slow under full-suite load.
    // Every 10th step covers the drag (0-29), the release (30) and the poke (50), not just the settled tail.
    const bad: string[] = [];
    for (const mood of DAVE_MOODS) {
      const b = createDaveBody(7);
      for (let i = 0; i < 400; i++) {
        stepDave(b, 1 / 60, { mood, input: 0.4, output: 0.4, look: { x: Math.sin(i), y: Math.cos(i) }, poke: i === 50, spin: i < 30 ? 0.2 : 0, dragging: i < 30 });
        if (i % 10 !== 0) continue;
        for (const size of [64, 180]) {
          const p = recorder();
          paintDave(b, b.time, p, DAVE_PALETTE, size);
          for (const c of p.calls) for (const a of c.args) if (typeof a === "number" && !Number.isFinite(a)) bad.push(`${mood} ${size}px step ${i}: ${c.op}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("paints only the front grid below the LOD size", () => {
    const b = createDaveBody(2);
    run(b, 1, { mood: "idle" });
    b.spin.yaw = 0.8;
    const small = paintDave(b, b.time, recorder(), DAVE_PALETTE, DAVE_LOD_PX - 8);
    expect(small.lod).toBe(true);
    expect(small.side + small.back + small.ear).toBe(0);
    expect(small.front).toBeGreaterThan(100);
    const big = paintDave(b, b.time, recorder(), DAVE_PALETTE, 180);
    expect(big.side).toBeGreaterThan(0);
    expect(big.ear).toBeGreaterThan(0);
  });

  it("decays a drag spin back to facing forward", () => {
    const b = createDaveBody(4);
    for (let i = 0; i < 12; i++) stepDave(b, 1 / 60, { mood: "idle", spin: 0.15, dragging: true });
    expect(b.spin.yaw).toBeGreaterThan(1.5);
    stepDave(b, 1 / 60, { mood: "idle" });
    expect(Math.abs(b.spin.v)).toBeGreaterThan(1);
    run(b, 5, { mood: "idle" });
    const off = b.spin.yaw - Math.round(b.spin.yaw / (Math.PI * 2)) * Math.PI * 2;
    expect(Math.abs(off)).toBeLessThan(0.01);
    expect(Math.abs(b.spin.v)).toBeLessThan(0.02);
    expect(daveEnergy(b)).toBeLessThan(0.05);
  });
});

describe("LED font", () => {
  it("covers A-Z, 0-9 and punctuation with 5x7 glyphs", () => {
    const chars = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", ".", ",", ":", "!", "?", "-", "'", "/", "…", " "];
    for (const ch of chars) {
      const glyph = FONT_5X7[ch];
      expect(glyph, ch).toBeDefined();
      expect(glyph?.length, ch).toBe(GLYPH_H);
      for (const row of glyph ?? []) expect(row, ch).toMatch(new RegExp(`^[#.]{${GLYPH_W}}$`));
      if (ch !== " ") expect(glyph?.join("").includes("#"), ch).toBe(true);
    }
    expect(glyphFor("a")).toBe(FONT_5X7.A);
    expect(glyphFor("~")).toBe(FONT_5X7[" "]);
    expect(layoutLedText("HI").width).toBe(11);
  });
});

describe("palette", () => {
  it("keeps LEDs at 4.5:1 or better on the stage", () => {
    for (const c of [DAVE_PALETTE.lit, DAVE_PALETTE.light, DAVE_PALETTE.glow, DAVE_PALETTE.oops]) {
      expect(contrast(c, DAVE_PALETTE.background), c).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast("#000", "#fff")).toBeCloseTo(21, 5);
  });
});
