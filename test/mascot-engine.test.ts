import { describe, expect, it } from "vitest";
import { createDaveBody, DAVE_LOD_PX, daveEnergy, eyeOpenness, mouthLevel, paintDave, paintStaticDave, projectFront, stepDave, type DaveBody, type DavePainter, type DaveStepInput } from "../src/ui/mascot/engine.ts";
import { FONT_5X7, GLYPH_H, GLYPH_W, glyphFor, layoutLedText } from "../src/ui/mascot/font5x7.ts";
import { contrast, DAVE_FORCED_PALETTE, DAVE_LIGHT_PALETTE, DAVE_PALETTE, davePalette } from "../src/ui/mascot/palette.ts";
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

describe("DAVE bot top hat and monocle", () => {
  /** A recorder that also records filled polygons as { op: "poly", args: [fill, stroke, ...points] }. */
  const polyRecorder = () => {
    const r = recorder();
    return Object.assign(r, { poly: (pts: readonly number[], fill: string, stroke?: string) => { r.calls.push({ op: "poly", args: [fill, stroke, ...pts] }); } });
  };
  const polysIn = (calls: Call[], fill: string) => calls.filter((c) => c.op === "poly" && c.args[0] === fill).map((c) => c.args.slice(2).map(Number));
  const minY = (pts: number[]) => Math.min(...pts.filter((_, i) => i % 2 === 1));
  const hatTop = (calls: Call[]) => Math.min(...polysIn(calls, DAVE_PALETTE.hat).map(minY));
  const headTop = (b: DaveBody, t: number) => Math.min(...projectFront(b, t, 180).map((p) => p.y));

  it("wears a top hat on the crown instead of an antenna", () => {
    const b = createDaveBody(1);
    stepDave(b, 0, { mood: "idle" });
    const p = polyRecorder();
    const stats = paintDave(b, 0, p, DAVE_PALETTE, 180);
    expect(polysIn(p.calls, DAVE_PALETTE.hat).length).toBeGreaterThanOrEqual(2);
    expect(stats.hat).toBeGreaterThan(20);
    expect(hatTop(p.calls)).toBeLessThan(headTop(b, 0) - 25);
    // The only strokes left are the monocle's rim: no antenna stalk.
    const lines = p.calls.filter((c) => c.op === "line");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((c) => c.args[4] === DAVE_PALETTE.monocle)).toBe(true);
  });

  it("lights the hat band with the mic level while listening", () => {
    const band = (input: number) => {
      const b = createDaveBody(1);
      run(b, 0.5, { mood: "listening", input });
      const p = recorder();
      paintDave(b, b.time, p, DAVE_PALETTE, 180);
      const top = headTop(b, b.time);
      return p.calls.filter((c) => c.op === "dot" && c.args[3] === DAVE_PALETTE.lit && Number(c.args[1]) < top).reduce((sum, c) => sum + Number(c.args[4] ?? 1), 0);
    };
    expect(band(0)).toBeGreaterThan(0);
    expect(band(0.9)).toBeGreaterThan(band(0) * 2);
  });

  it("tips the hat when poked", () => {
    const top = (poked: boolean) => {
      const b = createDaveBody(6);
      run(b, 0.5, { mood: "idle" });
      stepDave(b, 1 / 60, { mood: "idle", poke: poked });
      run(b, 0.4, { mood: "idle" });
      const p = polyRecorder();
      paintDave(b, b.time, p, DAVE_PALETTE, 180);
      return hatTop(p.calls);
    };
    expect(top(false) - top(true)).toBeGreaterThan(3);
  });

  it("wears the monocle over DAVE's right eye and hides it when turned away", () => {
    const b = createDaveBody(1);
    stepDave(b, 0, { mood: "listening" });
    const p = recorder();
    const front = paintDave(b, 0, p, DAVE_PALETTE, 180);
    expect(front.monocle).toBeGreaterThan(30);
    const beads = p.calls.filter((c) => c.op === "dot" && c.args[3] === DAVE_PALETTE.monocle).map((c) => Number(c.args[0]));
    expect(beads.reduce((s, x) => s + x, 0) / beads.length).toBeLessThan(90);
    b.spin.yaw = Math.PI;
    const q = recorder();
    const back = paintDave(b, 0, q, DAVE_PALETTE, 180);
    expect(back.monocle).toBe(0);
    expect(q.calls.some((c) => c.op === "line" || (c.op === "dot" && c.args[3] === DAVE_PALETTE.monocle))).toBe(false);
    expect(back.hat).toBeGreaterThan(0);
  });

  it("keeps the hat and monocle inside the canvas in every mood, even mid-poke and looking up", () => {
    const HAT_AND_MONOCLE = new Set([DAVE_PALETTE.hatDot, DAVE_PALETTE.monocle, DAVE_PALETTE.glint]);
    const out: string[] = [];
    for (const mood of DAVE_MOODS) {
      for (const size of [64, 180]) {
        const b = createDaveBody(0xda7e);
        for (let i = 0; i < 240; i++) {
          stepDave(b, 1 / 60, { mood, input: 0.5, output: 0.5, look: { x: Math.sin(i / 20), y: -1 }, poke: i % 60 === 10 });
          if (i % 6 !== 0) continue;
          const p = polyRecorder();
          paintDave(b, b.time, p, DAVE_PALETTE, size);
          for (const c of p.calls) {
            // Hat and monocle only: their polygons, the rim strokes and their own dot colours (band, felt, beads, glint).
            if (c.op === "glow" || c.op === "ellipse" || (c.op === "dot" && !HAT_AND_MONOCLE.has(String(c.args[3])))) continue;
            const nums = c.op === "poly" ? c.args.slice(2).map(Number) : c.op === "line" ? c.args.slice(0, 4).map(Number) : c.args.slice(0, 2).map(Number);
            const r = c.op === "dot" ? Number(c.args[2]) : 0;
            for (let k = 0; k < nums.length; k++) {
              const v = nums[k] ?? 0;
              if (v - r < -0.5 || v + r > size + 0.5) { out.push(`${mood} ${size}px step ${i}: ${c.op}`); break; }
            }
          }
        }
      }
    }
    expect([...new Set(out)]).toEqual([]);
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

  it("keeps the light stage's LEDs at 4.5:1 on the stage and on DAVE's pearl head", () => {
    for (const c of [DAVE_LIGHT_PALETTE.lit, DAVE_LIGHT_PALETTE.light, DAVE_LIGHT_PALETTE.oops]) {
      expect(contrast(c, DAVE_LIGHT_PALETTE.background), c).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c, DAVE_LIGHT_PALETTE.shell), c).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(DAVE_LIGHT_PALETTE.hat, DAVE_LIGHT_PALETTE.background)).toBeGreaterThanOrEqual(3);
    expect(contrast(DAVE_LIGHT_PALETTE.monocle, DAVE_LIGHT_PALETTE.shell)).toBeGreaterThanOrEqual(3);
    expect(contrast(DAVE_PALETTE.hatStroke, DAVE_PALETTE.background)).toBeGreaterThanOrEqual(3);
    expect(contrast(DAVE_PALETTE.monocle, DAVE_PALETTE.shell)).toBeGreaterThanOrEqual(3);
  });

  it("picks the palette by theme, with forced colors winning", () => {
    expect(davePalette("dark", false)).toBe(DAVE_PALETTE);
    expect(davePalette("light", false)).toBe(DAVE_LIGHT_PALETTE);
    expect(davePalette("light", true)).toBe(DAVE_FORCED_PALETTE);
    const LIGHT_LIT = new Set([DAVE_LIGHT_PALETTE.lit, DAVE_LIGHT_PALETTE.light, DAVE_LIGHT_PALETTE.oops]);
    for (const mood of DAVE_MOODS) {
      const p = recorder();
      paintStaticDave(mood, p, DAVE_LIGHT_PALETTE, 180);
      expect(p.calls.filter((c) => c.op === "dot" && LIGHT_LIT.has(String(c.args[3])) && Number(c.args[4] ?? 1) > 0.5).length, mood).toBeGreaterThan(4);
    }
  });
});
