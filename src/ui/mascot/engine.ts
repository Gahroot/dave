/**
 * DAVE bot engine: a squircle robot head made of LED dots, each on its own damped spring.
 * Pure and deterministic: all randomness comes from the body's seeded RNG, all time is injected.
 * Grid units: the head is a COLS x ROWS dot matrix; paint scales one grid unit to `pitch` px.
 */
import type { DaveMood } from "./types.ts";
import type { DavePalette } from "./palette.ts";

export type DavePainter = {
  dot(x: number, y: number, r: number, color: string, alpha?: number): void;
  glow(x: number, y: number, r: number, color: string, alpha?: number): void;
  roundRect(x: number, y: number, w: number, h: number, r: number, fill?: string, stroke?: string): void;
  line(x1: number, y1: number, x2: number, y2: number, color: string, width: number): void;
  ellipse(x: number, y: number, rx: number, ry: number, color: string, alpha?: number): void;
  /** Optional filled polygon (flat [x0, y0, x1, y1, ...]); painters without it get an ellipse fallback. */
  poly?(points: readonly number[], fill: string, stroke?: string): void;
};

export type DaveStepInput = {
  mood: DaveMood;
  /** Gaze target, each axis -1..1 (screen space, +y down). */
  look?: { x: number; y: number };
  /** Mic RMS 0..1. */
  input?: number;
  /** Speaker RMS 0..1. */
  output?: number;
  poke?: boolean;
  /** Drag spin: radians of yaw to add this step (pointer drag delta). */
  spin?: number;
  /** True while a pointer is dragging: holds the spin spring off. */
  dragging?: boolean;
};

type Dot = { c: number; r: number; u: number; v: number; rim: boolean; k: number; ox: number; oy: number; vx: number; vy: number };
type Spring2 = { x: number; y: number; vx: number; vy: number; ax: number; ay: number };

export type DaveBody = {
  rng: number;
  time: number;
  mood: DaveMood;
  moodTime: number;
  dots: Dot[];
  head: Spring2;
  squash: { s: number; v: number };
  /** Top hat wobble: a spring the head's motion and pokes swing (tilt = x * HAT_SWAY radians). */
  hat: { x: number; v: number };
  look: { x: number; y: number };
  saccade: { x: number; y: number; next: number };
  blink: { t: number; next: number; double: boolean };
  inLevel: number;
  outLevel: number;
  eq: number[];
  eqPhase: number[];
  pokeT: number;
  shakeT: number;
  /** Turntable yaw from drag-to-spin; springs back to the nearest forward angle. */
  spin: { yaw: number; v: number };
};

export const DAVE_COLS = 16;
export const DAVE_ROWS = 14;
const CX = (DAVE_COLS - 1) / 2;
const CY = (DAVE_ROWS - 1) / 2;
const EQ_COLS = 8;
const EQ_FIRST = 4;
const MOUTH_ROW = 10;
const EYE_ROW = 5.5;
const EYES = [{ x: 4, side: -1 }, { x: 11, side: 1 }] as const;
const BLINK_DUR = 0.16;
const POKE_DUR = 0.9;
const SHAKE_DUR = 0.6;
const SPIN_MAX_V = 24;
const TAU = Math.PI * 2;
/** Time used for the reduced-motion frame. */
export const DAVE_STATIC_T = 1.3;

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);
const finite = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) ? n : 0);
/** 1 inside half-width w, soft 0.45-unit edge. */
const band = (d: number, w: number) => clamp01((w - d) / 0.45 + 0.5);

function rand(b: DaveBody): number {
  b.rng = (b.rng + 0x6d2b79f5) | 0;
  let t = b.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function insideHead(c: number, r: number): boolean {
  const u = (c - CX) / 7.6;
  const v = (r - CY) / 6.6;
  return u ** 4 + v ** 4 <= 1;
}

export function createDaveBody(seed: number): DaveBody {
  const b: DaveBody = {
    rng: seed | 0, time: 0, mood: "idle", moodTime: 0, dots: [],
    head: { x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0 }, squash: { s: 0, v: 0 }, hat: { x: 0, v: 0 },
    look: { x: 0, y: 0 }, saccade: { x: 0, y: 0, next: 0 }, blink: { t: -1, next: 0, double: false },
    inLevel: 0, outLevel: 0, eq: [], eqPhase: [], pokeT: 0, shakeT: 0, spin: { yaw: 0, v: 0 },
  };
  for (let r = 0; r < DAVE_ROWS; r++) {
    for (let c = 0; c < DAVE_COLS; c++) {
      if (!insideHead(c, r)) continue;
      const rim = !insideHead(c - 1, r) || !insideHead(c + 1, r) || !insideHead(c, r - 1) || !insideHead(c, r + 1);
      b.dots.push({ c, r, u: (c - CX) / CX, v: (r - CY) / CY, rim, k: 170 + rand(b) * 70, ox: 0, oy: 0, vx: 0, vy: 0 });
    }
  }
  for (let i = 0; i < EQ_COLS; i++) { b.eq.push(0.3); b.eqPhase.push(rand(b) * Math.PI * 2); }
  b.saccade.next = 0.8 + rand(b) * 1.5;
  b.blink.next = 1.2 + rand(b) * 2;
  return b;
}

function poke(b: DaveBody): void {
  b.pokeT = POKE_DUR;
  b.head.vy -= 5;
  b.squash.v += 7;
  for (const d of b.dots) {
    const f = 4 + rand(b) * 2;
    d.vx += d.u * f;
    d.vy += d.v * f * 0.7;
  }
  b.hat.v += (rand(b) < 0.5 ? -1 : 1) * (8 + rand(b) * 6);
}

function substep(b: DaveBody, h: number, input: DaveStepInput): void {
  b.time += h;
  b.moodTime += h;
  b.pokeT = Math.max(0, b.pokeT - h);
  b.shakeT = Math.max(0, b.shakeT - h);
  const mood = b.mood;

  // Audio levels: fast attack, slower release.
  const inT = clamp01(finite(input.input));
  b.inLevel += (inT - b.inLevel) * Math.min(1, h * (inT > b.inLevel ? 30 : 6));
  const outT = clamp01(Math.sqrt(clamp01(finite(input.output)) * 3));
  b.outLevel += (outT - b.outLevel) * Math.min(1, h * (outT > b.outLevel ? 28 : 8));

  // Gaze: target plus seeded saccades.
  if (b.time >= b.saccade.next) {
    b.saccade.x = (rand(b) - 0.5) * 0.6;
    b.saccade.y = (rand(b) - 0.5) * 0.4;
    b.saccade.next = b.time + 0.7 + rand(b) * 2.3;
  }
  const lx = clamp(finite(input.look?.x), -1, 1);
  const ly = clamp(finite(input.look?.y), -1, 1);
  let tx = lx + b.saccade.x;
  let ty = ly + b.saccade.y;
  if (mood === "thinking") { tx = 0.6 + b.saccade.x * 0.3; ty = -0.35; }
  else if (mood === "sleepy") { tx = 0; ty = 0.3; }
  else if (mood === "working") { tx = lx * 0.5 + b.saccade.x * 0.5; ty = 0.5; }
  b.look.x += (clamp(tx, -1, 1) - b.look.x) * Math.min(1, h * 16);
  b.look.y += (clamp(ty, -1, 1) - b.look.y) * Math.min(1, h * 16);

  // Blinks: seeded cadence 2.5-6 s, occasional double blink.
  if (b.blink.t >= 0) {
    b.blink.t += h;
    if (b.blink.t >= BLINK_DUR) {
      b.blink.t = -1;
      if (b.blink.double) { b.blink.double = false; b.blink.next = b.time + 0.12; }
      else b.blink.next = b.time + 2.5 + rand(b) * 3.5;
    }
  } else if (b.time >= b.blink.next) {
    b.blink.t = 0;
    b.blink.double = rand(b) < 0.18;
  }

  // Head spring (follows gaze a little, shakes on oops).
  const shake = b.shakeT > 0 ? Math.sin(b.shakeT * 48) * 0.7 * (b.shakeT / SHAKE_DUR) : 0;
  const hd = b.head;
  hd.ax = 220 * (b.look.x * 0.35 + shake - hd.x) - 16 * hd.vx;
  hd.ay = 220 * (b.look.y * 0.25 - hd.y) - 16 * hd.vy;
  hd.vx += hd.ax * h; hd.vy += hd.ay * h;
  hd.x += hd.vx * h; hd.y += hd.vy * h;

  b.squash.v += (-200 * b.squash.s - 9 * b.squash.v) * h;
  b.squash.s += b.squash.v * h;

  b.hat.v += (-120 * b.hat.x - 6 * b.hat.v - hd.ax * 0.04) * h;
  b.hat.x += b.hat.v * h;

  for (const d of b.dots) {
    d.vx += (-d.k * d.ox - 13 * d.vx - hd.ax * 0.025) * h;
    d.vy += (-d.k * d.oy - 13 * d.vy - hd.ay * 0.025) * h;
    d.ox += d.vx * h; d.oy += d.vy * h;
  }

  // Equalizer mouth.
  for (let i = 0; i < EQ_COLS; i++) {
    let target = 0.3;
    if (mood === "speaking") {
      const wobble = 0.5 + 0.5 * Math.sin(b.time * (5 + (i % 3) * 2.3) + (b.eqPhase[i] ?? 0));
      const centre = 1 - 0.35 * ((i - 3.5) / 3.5) ** 2;
      target = 0.3 + b.outLevel * 1.9 * (0.55 + 0.45 * wobble) * centre;
    }
    const cur = b.eq[i] ?? 0.3;
    b.eq[i] = cur + (target - cur) * Math.min(1, h * (target > cur ? 30 : 12));
  }
}

/** Inertia plus a spring back to the nearest whole turn (DAVE ends up facing forward). */
function stepSpin(s: { yaw: number; v: number }, h: number): void {
  const target = Math.round(s.yaw / TAU) * TAU;
  s.v += (-26 * (s.yaw - target) - 5.5 * s.v) * h;
  s.yaw += s.v * h;
  if (Math.abs(s.yaw - target) < 1e-5 && Math.abs(s.v) < 1e-4) { s.yaw = 0; s.v = 0; }
}

export function stepDave(body: DaveBody, dtSeconds: number, input: DaveStepInput): DaveBody {
  if (input.mood !== body.mood) {
    body.mood = input.mood;
    body.moodTime = 0;
    body.squash.v += 1.5;
    if (input.mood === "oops") body.shakeT = SHAKE_DUR;
  }
  if (input.poke) poke(body);
  const dt = clamp(finite(dtSeconds), 0, 0.25);
  const spin = clamp(finite(input.spin), -Math.PI, Math.PI);
  if (spin !== 0) {
    body.spin.yaw += spin;
    if (dt > 0) body.spin.v = body.spin.v * 0.4 + clamp(spin / dt, -SPIN_MAX_V, SPIN_MAX_V) * 0.6;
  } else if (input.dragging) body.spin.v *= 0.5;
  let remaining = dt;
  while (remaining > 1e-9) {
    const h = Math.min(remaining, 1 / 60);
    substep(body, h, input);
    if (!input.dragging) stepSpin(body.spin, h);
    remaining -= h;
  }
  return body;
}

/** 1 = eyes fully open, 0 = shut (blink or sleepy). */
export function eyeOpenness(b: DaveBody): number {
  if (b.mood === "sleepy") return 0;
  return b.blink.t >= 0 ? 1 - Math.sin((Math.PI * b.blink.t) / BLINK_DUR) : 1;
}

/** Mean equalizer half-height in grid rows. */
export function mouthLevel(b: DaveBody): number {
  return b.eq.reduce((s, n) => s + n, 0) / Math.max(1, b.eq.length);
}

/** Remaining spring motion (poke wobble); ~0 when settled. */
export function daveEnergy(b: DaveBody): number {
  const spinOff = b.spin.yaw - Math.round(b.spin.yaw / TAU) * TAU;
  let e = Math.abs(b.squash.s) + Math.abs(b.squash.v) * 0.1 + Math.abs(b.hat.x) + Math.abs(spinOff) + Math.abs(b.spin.v) * 0.1;
  for (const d of b.dots) e = Math.max(e, Math.abs(d.ox) + Math.abs(d.oy) + (Math.abs(d.vx) + Math.abs(d.vy)) * 0.1);
  return e;
}

type Tone = "lit" | "light" | "oops";
type Px = { i: number; tone: Tone };

function faceMood(b: DaveBody): DaveMood {
  return b.pokeT > 0 && b.mood !== "oops" && b.mood !== "sleepy" ? "happy" : b.mood;
}

const BROWS: Partial<Record<DaveMood, { y: number; tilt: number; ry?: number; rtilt?: number }>> = {
  listening: { y: 2.4, tilt: 0 },
  hearing: { y: 2.0, tilt: -0.2 },
  thinking: { y: 2.6, tilt: 0, ry: 1.7, rtilt: -0.3 },
  working: { y: 3.0, tilt: 0.35 },
  oops: { y: 2.6, tilt: -0.45 },
};

function eyePx(b: DaveBody, mood: DaveMood, c: number, r: number, ex: number, side: number): Px {
  const dx0 = c - ex;
  if (mood === "happy") {
    const line = EYE_ROW - 1.5 + Math.abs(dx0);
    return { i: band(Math.abs(r - line), 0.3) * clamp01(2.6 - Math.abs(dx0)), tone: "lit" };
  }
  if (mood === "sleepy") {
    const line = EYE_ROW + 0.5 - Math.max(0, Math.abs(dx0) - 1);
    return { i: band(Math.abs(r - line), 0.3) * clamp01(2.6 - Math.abs(dx0)), tone: "lit" };
  }
  if (mood === "oops") {
    const dy = r - (EYE_ROW - 0.5);
    const ok = Math.max(Math.abs(dx0), Math.abs(dy)) <= 1.6 ? 1 : 0;
    return { i: band(Math.abs(Math.abs(dx0) - Math.abs(dy)), 0.3) * ok, tone: "oops" };
  }
  const dx = c - (ex + b.look.x * 0.9);
  const dy = r - (EYE_ROW + b.look.y * 0.8);
  const base = mood === "listening" || mood === "hearing" ? 1.95 : mood === "thinking" ? 1.5 : mood === "working" ? 1.3 : 1.75;
  const open = eyeOpenness(b);
  const hh = open < 0.25 ? 0.45 : base * open;
  const hw = 1.45;
  const d = ((dx / hw) ** 4 + (dy / hh) ** 4) ** 0.25;
  const i = clamp01((1.05 - d) * 3 + 0.5);
  const hx = dx + 0.55 + side * 0.05;
  const hy = dy + Math.min(0.8, hh * 0.45);
  const light = open >= 0.25 && hx * hx + hy * hy < 0.36;
  return { i, tone: light ? "light" : "lit" };
}

function browPx(mood: DaveMood, c: number, r: number, ex: number, side: number): number {
  const cfg = BROWS[mood];
  if (!cfg) return 0;
  const right = side > 0;
  const y = right && cfg.ry !== undefined ? cfg.ry : cfg.y;
  const tilt = right && cfg.rtilt !== undefined ? cfg.rtilt : cfg.tilt;
  const dx = c - ex;
  const inner = right ? -dx : dx;
  const row = y + tilt * inner;
  return band(Math.abs(r - row), 0.3) * clamp01(2 - Math.abs(dx));
}

function mouthPx(b: DaveBody, mood: DaveMood, c: number, r: number): Px {
  const dx = c - CX;
  const dy = r - MOUTH_ROW;
  const smile = (w: number, depth: number) => Math.abs(dx) > w ? 0 : band(Math.abs(r - (MOUTH_ROW + 0.3 - depth * dx * dx)), 0.3);
  switch (mood) {
    case "speaking": {
      const col = c - EQ_FIRST;
      if (col < 0 || col >= EQ_COLS) return { i: 0, tone: "lit" };
      const hgt = b.eq[col] ?? 0.3;
      return { i: band(Math.abs(dy), hgt), tone: Math.abs(dy) >= 1.5 ? "light" : "lit" };
    }
    case "happy": {
      if (Math.abs(dx) > 3.2) return { i: 0, tone: "lit" };
      const top = MOUTH_ROW - 0.6;
      const bottom = MOUTH_ROW + 1.3 - 0.15 * dx * dx;
      return { i: clamp01(Math.min(r - top, bottom - r) / 0.45 + 0.5), tone: "lit" };
    }
    case "hearing": {
      const d = Math.hypot(dx / 1.3, dy / 1.1);
      return { i: band(Math.abs(d - 1), 0.22), tone: "lit" };
    }
    case "thinking":
      return { i: dx >= -0.6 && dx <= 2.6 ? band(Math.abs(dy), 0.3) : 0, tone: "lit" };
    case "working":
      return { i: Math.abs(dx) <= 2.6 ? band(Math.abs(dy), 0.3) : 0, tone: "lit" };
    case "sleepy":
      return { i: Math.abs(dx) <= 1 ? band(Math.abs(dy), 0.3) : 0, tone: "lit" };
    case "oops":
      return { i: Math.abs(dx) > 2.6 ? 0 : band(Math.abs(r - (MOUTH_ROW - 0.4 + 0.15 * dx * dx)), 0.3), tone: "oops" };
    case "listening":
      return { i: smile(1.6, 0.55), tone: "lit" };
    default:
      return { i: smile(2.6, 0.21), tone: "lit" };
  }
}

function facePx(b: DaveBody, mood: DaveMood, c: number, r: number, t: number): Px {
  let best: Px = { i: 0, tone: "lit" };
  const take = (p: Px) => { if (p.i > best.i) best = p; };
  for (const e of EYES) {
    take(eyePx(b, mood, c, r, e.x, e.side));
    const bi = browPx(mood, c, r, e.x, e.side);
    if (bi > 0) take({ i: bi, tone: mood === "oops" ? "oops" : "lit" });
  }
  if (r >= 8) take(mouthPx(b, mood, c, r));
  if (mood === "thinking" && r === 1) {
    const pos = 3 + 9 * (0.5 + 0.5 * Math.sin(t * 2.6));
    take({ i: clamp01(1 - Math.abs(c - pos) / 1.4), tone: "light" });
  }
  return best;
}

/** The hat band's LEDs: they glow with the mic while listening and pulse with each mood (the old antenna bulb). */
function bandAlpha(b: DaveBody, mood: DaveMood, t: number): number {
  switch (mood) {
    case "listening": return 0.3 + 0.7 * b.inLevel;
    case "hearing": return 0.5 + 0.5 * b.inLevel;
    case "thinking": return Math.sin(t * 7) > 0 ? 1 : 0.15;
    case "speaking": return 0.4 + 0.6 * b.outLevel;
    case "working": return 0.5 + 0.5 * Math.sin(t * 5) ** 2;
    case "happy": return 1;
    case "sleepy": return 0.15 + 0.1 * Math.sin(t * 0.8);
    case "oops": return Math.sin(t * 6) > -0.3 ? 1 : 0.3;
    default: return 0.45 + 0.1 * Math.sin(t * 1.5);
  }
}

const Z_CELLS = [[0, 0], [1, 0], [2, 0], [1, 1], [0, 2], [1, 2], [2, 2]] as const;

// ---------------------------------------------------------------------------
// 3D head: superellipsoid |x/A|^4 + |y/B|^4 + |z/C|^4 = 1 (local units, +y down, +z toward the camera).

const HA = 1;
const HB = 0.88;
const HC = 0.7;
const CAM = 4.2;
/** Head centre and ground shadow, as fractions of the canvas height: low enough to leave room for the top hat. */
const HEAD_CY = 0.62;
const SHADOW_CY = 0.955;
/** One head unit in canvas heights. */
const HEAD_SCALE = 0.34;
/** The front grid covers this fraction of the head's x/y extent. */
const FACE_S = 0.92;
const UX = (HA * FACE_S) / 7.6;
const UY = (HB * FACE_S) / 6.6;
const SIDE_LAYERS = [0.38, 0.19, 0, -0.19, -0.38] as const;
const SIDE_RING = 34;
const EAR_Y = -0.05;
const EAR_R = 0.26;
/** Below this size only the front grid is drawn (dock/avatar). */
export const DAVE_LOD_PX = 72;
/** Yaw of the reduced-motion 3/4 view. */
export const DAVE_STATIC_YAW = 0.3;

// Top hat, in hat-local units (origin at the brim centre, +y down), tipped toward DAVE's left so its low edge
// rests on the head. A poke tips it: it hops up and tilts, then settles.
const HAT_X = 0.05;
const HAT_Y = -HB - 0.012;
const HAT_TILT = 0.07;
const HAT_SWAY = 0.07;
const BRIM_R = 0.58;
const BRIM_T = 0.035;
const BRIM_CURL = 0.035;
const CROWN_R0 = 0.37;
const CROWN_R1 = 0.4;
const CROWN_H = 0.56;
const BAND_H = 0.1;
const HAT_RING = 32;
const BAND_DOTS = 22;
const FELT_ROWS = [0.21, 0.3, 0.39, 0.48] as const;
const FELT_DOTS = 22;
const TIP_LIFT = 0.07;
const TIP_TILT = 0.12;
// Monocle over DAVE's right eye (screen left), on a chain that hangs to the ear.
const MONO_EYE = EYES[0];
const MONO_R = 2.45;
const MONO_LIFT = 0.05;
const MONO_BEADS = 30;
const CHAIN_BEADS = 10;
const CHAIN_END = { x: -0.99, y: 0.14 } as const;
const CHAIN_SAG = 0.2;

export type DavePart = "front" | "side" | "back" | "ear";
type ShellPt = { part: Exclude<DavePart, "front">; x: number; y: number; z: number; nx: number; ny: number; nz: number; ear: number };

function norm3(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}
/** Superellipsoid gradient: the outward normal. */
function headNormal(x: number, y: number, z: number): [number, number, number] {
  return norm3(x ** 3 / HA ** 4, y ** 3 / HB ** 4, z ** 3 / HC ** 4);
}
/** z of the head surface at (x, y), front side. */
function surfaceZ(x: number, y: number): number {
  return HC * Math.max(0, 1 - (x / HA) ** 4 - (y / HB) ** 4) ** 0.25;
}
const spow = (n: number, p: number) => Math.sign(n) * Math.abs(n) ** p;

function buildShell(): readonly ShellPt[] {
  const pts: ShellPt[] = [];
  for (const z of SIDE_LAYERS) {
    const R = (1 - (z / HC) ** 4) ** 0.25;
    const off = z === 0 || z === -0.38 || z === 0.38 ? 0 : 0.5;
    for (let i = 0; i < SIDE_RING; i++) {
      const th = ((i + off) / SIDE_RING) * TAU;
      const x = HA * R * spow(Math.cos(th), 0.5);
      const y = HB * R * spow(Math.sin(th), 0.5);
      const [nx, ny, nz] = headNormal(x, y, z);
      pts.push({ part: "side", x, y, z, nx, ny, nz, ear: 0 });
    }
  }
  for (let r = 0; r < DAVE_ROWS; r++) {
    for (let c = 0; c < DAVE_COLS; c++) {
      if (!insideHead(c, r)) continue;
      const x = -(c - CX) * UX;
      const y = (r - CY) * UY;
      const z = -surfaceZ(x, y);
      const [nx, ny, nz] = headNormal(x, y, z);
      pts.push({ part: "back", x, y, z, nx, ny, nz, ear: 0 });
    }
  }
  for (const side of [-1, 1]) {
    for (const ex of [1.0, 1.08]) {
      for (let i = 0; i < 12; i++) {
        const ph = (i / 12) * TAU;
        pts.push({ part: "ear", x: side * ex, y: EAR_Y + Math.sin(ph) * EAR_R, z: Math.cos(ph) * EAR_R, nx: 0, ny: Math.sin(ph), nz: Math.cos(ph), ear: side });
      }
    }
    pts.push({ part: "ear", x: side * 1.14, y: EAR_Y, z: 0, nx: side, ny: 0, nz: 0, ear: side });
    for (let i = 0; i < 6; i++) {
      const ph = (i / 6) * TAU;
      pts.push({ part: "ear", x: side * 1.14, y: EAR_Y + Math.sin(ph) * 0.14, z: Math.cos(ph) * 0.14, nx: side, ny: 0, nz: 0, ear: side });
    }
  }
  return pts;
}
/** Immutable shell geometry (side band, back grid, ears); the front grid lives on the body's dots. */
const SHELL: readonly ShellPt[] = Object.freeze(buildShell());

type Pose = { yaw: number; pitch: number; roll: number; cx: number; cy: number; scale: number; sx: number; sy: number };

export type DaveProjected = { x: number; y: number; depth: number; f: number; facing: number; light: number };

function daveP(b: DaveBody, t: number, size: number): Pose {
  const mood = b.mood;
  const sway = mood === "idle" ? Math.sin(t * 0.6) * 0.12 : Math.sin(t * 0.45) * 0.04;
  let yaw = b.head.x * 0.55 + b.spin.yaw + sway;
  let pitch = b.head.y * 0.35;
  let roll = b.head.x * 0.06;
  let lift = 0;
  if (mood === "sleepy") { pitch += 0.25; lift = Math.sin(t * 1.2) * 0.02; }
  if (mood === "thinking") { yaw += 0.28; roll += 0.1; }
  if (mood === "oops" && b.shakeT > 0) yaw += Math.sin(b.shakeT * 40) * 0.25 * (b.shakeT / SHAKE_DUR);
  if (mood === "happy") lift -= Math.abs(Math.sin(t * 5.5)) * 0.05;
  if (mood === "idle") lift += Math.sin(t * 1.6) * 0.006;
  return {
    yaw, pitch, roll, cx: size / 2, cy: size * (HEAD_CY + lift), scale: size * HEAD_SCALE,
    sx: 1 + b.squash.s * 0.06, sy: 1 - b.squash.s * 0.06,
  };
}

const KEY = norm3(-0.45, -0.6, 0.66);
const RIM = norm3(0.6, -0.2, -0.75);

function makeProjector(p: Pose) {
  const cyw = Math.cos(p.yaw), syw = Math.sin(p.yaw), cp = Math.cos(p.pitch), sp = Math.sin(p.pitch);
  const cr = Math.cos(p.roll), sr = Math.sin(p.roll);
  const rot = (x: number, y: number, z: number): [number, number, number] => {
    const x1 = x * cyw + z * syw;
    const z1 = -x * syw + z * cyw;
    return [x1, y * cp + z1 * sp, -y * sp + z1 * cp];
  };
  return (x: number, y: number, z: number, nx: number, ny: number, nz: number): DaveProjected => {
    const [px, py, pz] = rot(x * p.sx, y * p.sy, z);
    const [qx, qy, qz] = rot(nx, ny, nz);
    const f = CAM / Math.max(0.5, CAM - pz);
    const X = px * f * p.scale;
    const Y = py * f * p.scale;
    const [vx, vy, vz] = norm3(-px, -py, CAM - pz);
    const facing = qx * vx + qy * vy + qz * vz;
    const lambert = Math.max(0, qx * KEY[0] + qy * KEY[1] + qz * KEY[2]);
    const rim = Math.max(0, qx * RIM[0] + qy * RIM[1] + qz * RIM[2]) * 0.25 + 0.2 * clamp01(1 - facing) ** 3;
    return { x: p.cx + X * cr - Y * sr, y: p.cy + X * sr + Y * cr, depth: pz, f, facing, light: clamp01(0.22 + 0.78 * lambert + rim) };
  };
}

/** Andrew's monotone chain; returns hull vertices pushed outward by `pad`. */
function hull(points: [number, number][], pad: number): number[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts.flat();
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2] as [number, number], lower[lower.length - 1] as [number, number], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i] as [number, number];
    while (upper.length >= 2 && cross(upper[upper.length - 2] as [number, number], upper[upper.length - 1] as [number, number], p) <= 0) upper.pop();
    upper.push(p);
  }
  const h = lower.slice(0, -1).concat(upper.slice(0, -1));
  let mx = 0, my = 0;
  for (const [x, y] of h) { mx += x; my += y; }
  mx /= h.length; my /= h.length;
  const out: number[] = [];
  for (const [x, y] of h) {
    const l = Math.hypot(x - mx, y - my) || 1;
    out.push(x + ((x - mx) / l) * pad, y + ((y - my) / l) * pad);
  }
  return out;
}

function fillPoly(painter: DavePainter, pts: number[], fill: string, stroke: string): void {
  if (pts.length < 6) return;
  if (painter.poly) { painter.poly(pts, fill, stroke); return; }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = pts[i] ?? 0, y = pts[i + 1] ?? 0;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  painter.ellipse((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, fill);
}

/**
 * What one paint drew: dots per head part (after culling) and how many head dots were culled; `hat` counts the
 * band and felt dots drawn, `monocle` the rim and chain beads (0 when the face is turned away).
 */
export type DavePaintStats = { front: number; side: number; back: number; ear: number; culled: number; lod: boolean; hat: number; monocle: number };

type Item = { depth: number; part: DavePart; dot: number; pr: DaveProjected };

/** Projected front-grid dots (index matches body.dots), for tests and tools. */
export function projectFront(body: DaveBody, tSeconds: number, size: number): DaveProjected[] {
  const proj = makeProjector(daveP(body, tSeconds, size));
  return body.dots.map((d) => frontPoint(d, proj));
}

function frontPoint(d: Dot, proj: ReturnType<typeof makeProjector>): DaveProjected {
  const x = (d.c - CX) * UX + d.ox * UX;
  const y = (d.r - CY) * UY + d.oy * UY;
  const bx = (d.c - CX) * UX;
  const by = (d.r - CY) * UY;
  const z = surfaceZ(bx, by);
  const [nx, ny, nz] = headNormal(bx, by, z);
  return proj(x, y, z, nx, ny, nz);
}

export function paintDave(body: DaveBody, tSeconds: number, painter: DavePainter, palette: DavePalette, size: number): DavePaintStats {
  const b = body;
  const t = tSeconds;
  const mood = b.mood;
  const fm = faceMood(b);
  const pose = daveP(b, t, size);
  const proj = makeProjector(pose);
  const lod = size < DAVE_LOD_PX;
  const pitch = UX * pose.scale;
  const glowOn = palette.glowEnabled;
  const ledColor = (tone: Tone) => (tone === "light" ? palette.light : tone === "oops" ? palette.oops : palette.lit);
  const stats: DavePaintStats = { front: 0, side: 0, back: 0, ear: 0, culled: 0, lod, hat: 0, monocle: 0 };

  // Project everything once.
  const shell = SHELL.map((s) => proj(s.x, s.y, s.z, s.nx, s.ny, s.nz));
  const front = b.dots.map((d) => frontPoint(d, proj));

  // Ground shadow.
  const lift = pose.cy - size * HEAD_CY;
  painter.ellipse(pose.cx, size * SHADOW_CY, pose.scale * (0.95 + lift / size), pose.scale * 0.13, "#000", palette.shadow);

  // Silhouettes: head hull and ear hulls.
  const headPts: [number, number][] = [];
  const earPts: Record<string, [number, number][]> = { "-1": [], "1": [] };
  const earDepth: Record<string, number> = { "-1": 0, "1": 0 };
  SHELL.forEach((s, i) => {
    const p = shell[i];
    if (!p) return;
    if (s.part === "ear") { earPts[String(s.ear)]?.push([p.x, p.y]); if (s.nx !== 0 && s.ny === 0 && s.nz === 0 && Math.abs(s.y - EAR_Y) < 1e-9 && s.z === 0) earDepth[String(s.ear)] = p.depth; }
    else headPts.push([p.x, p.y]);
  });
  for (const p of front) headPts.push([p.x, p.y]);
  const pad = pitch * 0.45;

  const drawEar = (side: number) => {
    fillPoly(painter, hull(earPts[String(side)] ?? [], pad * 0.6), palette.shell, palette.shellStroke);
    if (lod) return;
    SHELL.forEach((s, i) => {
      const p = shell[i];
      if (!p || s.part !== "ear" || s.ear !== side) return;
      if (p.facing < -0.05) { stats.culled++; return; }
      stats.ear++;
      painter.dot(p.x, p.y, pitch * 0.26 * p.f, palette.off, clamp01(0.35 + 0.65 * p.light) * clamp01((p.facing + 0.05) / 0.35));
    });
  };
  const far = [-1, 1].filter((s) => (earDepth[String(s)] ?? 0) < -1e-6);
  const near = [-1, 1].filter((s) => !far.includes(s));
  for (const s of far) drawEar(s);
  fillPoly(painter, hull(headPts, pad), palette.shell, palette.shellStroke);

  // Dots, back to front.
  const items: Item[] = [];
  front.forEach((pr, i) => items.push({ depth: pr.depth, part: "front", dot: i, pr }));
  if (!lod) SHELL.forEach((s, i) => { const pr = shell[i]; if (pr && s.part !== "ear") items.push({ depth: pr.depth, part: s.part, dot: -1, pr }); });
  items.sort((p, q) => p.depth - q.depth);
  for (const it of items) {
    const p = it.pr;
    if (p.facing < -0.05) { stats.culled++; continue; }
    const fade = clamp01((p.facing + 0.05) / 0.35);
    const shade = lod ? clamp01(0.55 + 0.45 * p.facing) : p.light;
    const shellA = clamp01(0.3 + 0.7 * shade) * fade;
    const r = pitch * 0.3 * p.f;
    if (it.part !== "front") {
      stats[it.part]++;
      painter.dot(p.x, p.y, r * 0.95, shade > 0.85 ? palette.rim : palette.off, shellA);
      continue;
    }
    const d = b.dots[it.dot];
    if (!d) continue;
    stats.front++;
    if (d.rim) { painter.dot(p.x, p.y, r, palette.rim, shellA); continue; }
    const px = facePx(b, fm, d.c, d.r, t);
    if (px.i < 0.04) { painter.dot(p.x, p.y, r, palette.off, shellA); continue; }
    if (px.i < 0.95) painter.dot(p.x, p.y, r, palette.off, shellA);
    const emit = clamp01((p.facing + 0.05) / 0.3);
    if (glowOn && px.i > 0.3) painter.glow(p.x, p.y, pitch * 1.3 * p.f, px.tone === "oops" ? palette.oops : palette.glow, 0.2 * px.i * emit);
    painter.dot(p.x, p.y, pitch * (px.tone === "light" ? 0.4 : 0.37) * p.f, ledColor(px.tone), px.i * emit);
  }
  paintMonocle(b, proj, painter, palette, pitch, lod, stats);
  for (const s of near) drawEar(s);
  paintHat(b, mood, t, proj, painter, palette, pitch, lod, stats);

  // Mood extras, in screen space around the projected head.
  const px = (c: number) => pose.cx + (c - CX) * pitch;
  const py = (r: number) => pose.cy + (r - CY) * pitch;
  const sparkle = mood === "happy" ? 1 : b.pokeT > 0 && fm === "happy" ? b.pokeT / POKE_DUR : 0;
  if (sparkle > 0) {
    const spots = [[-2.2, 0.2], [17.8, 1.8], [17.4, 12.6]] as const;
    spots.forEach(([c, r], k) => {
      const a = 0.5 + 0.5 * Math.sin(t * 3.2 + k * 2.1);
      const x = px(c);
      const y = py(r);
      const arm = pitch * (0.5 + 0.6 * a);
      if (glowOn) painter.glow(x, y, pitch * 1.6, palette.glow, 0.35 * a * sparkle);
      painter.dot(x, y, pitch * 0.34, palette.light, sparkle);
      for (const [ddx, ddy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) painter.dot(x + ddx * arm, y + ddy * arm, pitch * 0.2, palette.lit, (0.4 + 0.6 * a) * sparkle);
    });
  }
  if (mood === "sleepy") {
    for (let i = 0; i < 3; i++) {
      const ph = (t * 0.22 + i / 3) % 1;
      const s = pitch * (0.45 + 0.35 * ph);
      const zx = px(12.8 + 2.6 * ph) + Math.sin(ph * 6 + i) * pitch * 0.4;
      const zy = py(-0.5 - 4.2 * ph);
      const a = Math.sin(Math.PI * ph);
      for (const [cx, cy] of Z_CELLS) painter.dot(zx + (cx - 1) * s, zy + (cy - 1) * s, s * 0.4, palette.lit, a);
    }
  }
  if (mood === "working") {
    // A tilted 3D orbit ring: dots behind the head are skipped.
    for (let k = 0; k < 2; k++) {
      for (let j = 0; j < 5; j++) {
        const ang = t * 2.6 - j * 0.24 + k * Math.PI;
        const o = proj(Math.cos(ang) * 1.35, Math.sin(ang) * 0.35, Math.sin(ang) * 1.1, 0, 0, 1);
        if (o.depth < -0.15 && Math.abs(o.x - pose.cx) < pose.scale * 1.05) continue;
        if (glowOn && j === 0) painter.glow(o.x, o.y, pitch * 1.4 * o.f, palette.glow, 0.4);
        painter.dot(o.x, o.y, pitch * (0.42 - j * 0.05) * o.f, j === 0 ? palette.light : palette.lit, 1 - j * 0.18);
      }
    }
  }
  return stats;
}

type Projector = ReturnType<typeof makeProjector>;
type V3 = [number, number, number];

/** Brim centre pose: the resting tilt plus the wobble spring, and the hop and extra tilt of a poke's hat tip. */
function hatPose(b: DaveBody): { tilt: number; lift: number } {
  const tip = b.pokeT > 0 ? Math.sin(Math.PI * (1 - b.pokeT / POKE_DUR)) : 0;
  return { tilt: HAT_TILT + b.hat.x * HAT_SWAY + tip * TIP_TILT, lift: tip * TIP_LIFT };
}

/** Top hat: brim and crown silhouettes, a lit top when seen from above, felt dots and the LED band. */
function paintHat(b: DaveBody, mood: DaveMood, t: number, proj: Projector, painter: DavePainter, palette: DavePalette, pitch: number, lod: boolean, stats: DavePaintStats): void {
  const pose = hatPose(b);
  const c = Math.cos(pose.tilt);
  const sn = Math.sin(pose.tilt);
  const at = (hx: number, hy: number, hz: number, nx = 0, ny = -1, nz = 0): DaveProjected =>
    proj(HAT_X + hx * c - hy * sn, HAT_Y - pose.lift + hx * sn + hy * c, hz, nx * c - ny * sn, nx * sn + ny * c, nz);
  const ring = (y: number, r: number, n: number, off = 0, curl = 0): DaveProjected[] => {
    const out: DaveProjected[] = [];
    for (let i = 0; i < n; i++) {
      const th = ((i + off) / n) * TAU;
      const cx = Math.cos(th);
      const sz = Math.sin(th);
      out.push(at(cx * r, y - curl * cx * cx, sz * r, cx, 0, sz));
    }
    return out;
  };
  const xy = (ps: DaveProjected[]): [number, number][] => ps.map((p) => [p.x, p.y]);

  const brim = hull([...xy(ring(0, BRIM_R, HAT_RING, 0, BRIM_CURL)), ...xy(ring(BRIM_T, BRIM_R, HAT_RING, 0, BRIM_CURL))], 0);
  const top = ring(-CROWN_H, CROWN_R1, HAT_RING);
  const crown = hull([...xy(ring(-0.01, CROWN_R0, HAT_RING)), ...xy(top)], 0);
  // Seen from above, the crown stands on the brim; from below, the brim hides the crown's foot.
  const brimTopShows = at(0, 0, 0).facing > 0;
  if (brimTopShows) fillPoly(painter, brim, palette.hat, palette.hatStroke);
  fillPoly(painter, crown, palette.hat, palette.hatStroke);
  if (at(0, -CROWN_H, 0).facing > 0) fillPoly(painter, top.flatMap((p) => [p.x, p.y]), palette.hatTop, palette.hatStroke);

  const radiusAt = (h: number) => CROWN_R0 + (CROWN_R1 - CROWN_R0) * (h / CROWN_H);
  if (!lod) {
    FELT_ROWS.forEach((h, row) => {
      for (const p of ring(-h, radiusAt(h) + 0.004, FELT_DOTS, row % 2 ? 0.5 : 0)) {
        if (p.facing < 0.02) continue;
        stats.hat++;
        const fade = clamp01(p.facing / 0.3);
        painter.dot(p.x, p.y, pitch * 0.24 * p.f, p.light > 0.85 ? palette.rim : palette.hatDot, clamp01(0.25 + 0.75 * p.light) * fade);
      }
    });
  }
  const ba = bandAlpha(b, mood, t);
  const bandColor = mood === "oops" ? palette.oops : palette.lit;
  for (const p of ring(-BAND_H, radiusAt(BAND_H) + 0.006, BAND_DOTS)) {
    if (p.facing < 0.02) continue;
    stats.hat++;
    const fade = clamp01(p.facing / 0.3);
    const r = pitch * (lod ? 0.34 : 0.3) * p.f;
    if (palette.glowEnabled && fade > 0.5) painter.glow(p.x, p.y, pitch * 1.2 * p.f, mood === "oops" ? palette.oops : palette.glow, 0.22 * ba * fade);
    painter.dot(p.x, p.y, r, palette.hatDot, fade);
    painter.dot(p.x, p.y, r, bandColor, ba * fade);
  }
  if (brimTopShows) return;
  fillPoly(painter, brim, palette.hat, palette.hatStroke);
}

/** A point on the face just proud of the head surface, with the surface normal there. */
function onFace(x: number, y: number, lift: number): { p: V3; n: V3 } {
  const z = surfaceZ(x, y);
  return { p: [x, y, z + lift], n: headNormal(x, y, z) };
}

/** Monocle: a bead rim around DAVE's right eye, a glint on the lens and a chain that swings to the ear. */
function paintMonocle(b: DaveBody, proj: Projector, painter: DavePainter, palette: DavePalette, pitch: number, lod: boolean, stats: DavePaintStats): void {
  const ex = (MONO_EYE.x - CX) * UX;
  const ey = (EYE_ROW - CY) * UY;
  const rx = MONO_R * UX;
  const ry = MONO_R * UY;
  const rim: DaveProjected[] = [];
  for (let i = 0; i < MONO_BEADS; i++) {
    const th = (i / MONO_BEADS) * TAU;
    const f = onFace(ex + Math.cos(th) * rx, ey + Math.sin(th) * ry, MONO_LIFT);
    rim.push(proj(...f.p, ...f.n));
  }
  const width = Math.max(1, pitch * 0.16 * (rim[0]?.f ?? 1));
  rim.forEach((p, i) => {
    const q = rim[(i + 1) % rim.length];
    if (q && p.facing > 0.15 && q.facing > 0.15) painter.line(p.x, p.y, q.x, q.y, palette.monocle, width);
  });
  if (lod) { stats.monocle += rim.filter((p) => p.facing > 0.15).length; return; }
  const bead = (p: DaveProjected, r: number, color: string, alpha = 1) => {
    if (p.facing < 0.02) return;
    stats.monocle++;
    painter.dot(p.x, p.y, r * p.f, color, alpha * clamp01(p.facing / 0.3));
  };
  for (const p of rim) bead(p, pitch * 0.2, palette.monocle);
  if (palette.glowEnabled) {
    // Lens glint: a short arc inside the rim, upper left.
    for (let k = 0; k < 4; k++) {
      const th = Math.PI * (1.12 + k * 0.1);
      const f = onFace(ex + Math.cos(th) * rx * 0.66, ey + Math.sin(th) * ry * 0.66, MONO_LIFT);
      bead(proj(...f.p, ...f.n), pitch * (0.15 - k * 0.02), palette.glint, 0.55 - k * 0.1);
    }
  }
  // Chain: from the rim's lower outer edge, sagging (and swinging with the hat spring) to the ear.
  const a0 = Math.PI * 0.8;
  const sx = ex + Math.cos(a0) * rx;
  const sy = ey + Math.sin(a0) * ry;
  for (let i = 1; i <= CHAIN_BEADS; i++) {
    const u = i / CHAIN_BEADS;
    const sag = Math.sin(Math.PI * u);
    const x = sx + (CHAIN_END.x - sx) * u + b.hat.x * UX * 0.5 * sag;
    const y = sy + (CHAIN_END.y - sy) * u + CHAIN_SAG * sag;
    const f = onFace(clamp(x, -HA * 0.995, HA * 0.995), clamp(y, -HB * 0.995, HB * 0.995), 0.03);
    bead(proj(...f.p, ...f.n), pitch * 0.13, palette.monocle, 0.9);
  }
}

/** One stable 3/4-view frame for reduced motion: no springs, no blink, fixed time. */
export function paintStaticDave(mood: DaveMood, painter: DavePainter, palette: DavePalette, size: number, seed = 1): DavePaintStats {
  const b = createDaveBody(seed);
  stepDave(b, 0, { mood });
  b.shakeT = 0;
  b.spin.yaw = DAVE_STATIC_YAW;
  if (mood === "speaking") b.eq = [0.6, 1.2, 1.7, 1.0, 1.4, 1.9, 1.1, 0.6];
  if (mood === "listening" || mood === "hearing") b.inLevel = 0.6;
  return paintDave(b, DAVE_STATIC_T, painter, palette, size);
}
