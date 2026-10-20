import type { DaveTheme } from "./types.ts";

/** DAVE bot colours: violet LEDs on a near-black stage ("violet = DAVE"), or on a pearl head for the light stage. */
export type DavePalette = {
  background: string;
  shell: string;
  shellStroke: string;
  off: string;
  rim: string;
  lit: string;
  light: string;
  glow: string;
  oops: string;
  /** Top hat felt, its top, its outline and the felt texture dots. */
  hat: string;
  hatTop: string;
  hatStroke: string;
  hatDot: string;
  /** Monocle rim and chain, and the glint on its lens. */
  monocle: string;
  glint: string;
  /** Ground shadow opacity, 0..1. */
  shadow: number;
  /** Soft radial glows; off under forced colors. */
  glowEnabled: boolean;
};

export const DAVE_PALETTE: DavePalette = {
  background: "#0a0a0c",
  shell: "#121018",
  shellStroke: "#2e2840",
  off: "#24202f",
  rim: "#3b3352",
  lit: "#9d8cff",
  light: "#d6ceff",
  glow: "#beb0ff",
  oops: "#ff6b60",
  hat: "#1c1826",
  hatTop: "#2a2438",
  hatStroke: "#62568a",
  hatDot: "#2e2840",
  monocle: "#cfc8ee",
  glint: "#ffffff",
  shadow: 0.45,
  glowEnabled: true,
};

/**
 * Light stage: a pearl head whose bead dots catch the light (white where lit, fading into the shell in shade),
 * deep violet LEDs, a plum-black top hat and a gunmetal monocle. Background matches the light voice stage.
 */
export const DAVE_LIGHT_PALETTE: DavePalette = {
  background: "#f7f6fb",
  shell: "#e4e0ef",
  shellStroke: "#bdb4d6",
  off: "#fdfcff",
  rim: "#ffffff",
  lit: "#6741d9",
  light: "#4320b0",
  glow: "#8f78ff",
  oops: "#b3261e",
  hat: "#2b2540",
  hatTop: "#3d3556",
  hatStroke: "#16121f",
  hatDot: "#3b3352",
  monocle: "#4a4262",
  glint: "#ffffff",
  shadow: 0.16,
  glowEnabled: true,
};

/** Forced-colors (Windows high contrast): system colours only, no glow. */
export const DAVE_FORCED_PALETTE: DavePalette = {
  background: "Canvas",
  shell: "Canvas",
  shellStroke: "CanvasText",
  off: "GrayText",
  rim: "GrayText",
  lit: "CanvasText",
  light: "CanvasText",
  glow: "CanvasText",
  oops: "CanvasText",
  hat: "Canvas",
  hatTop: "Canvas",
  hatStroke: "CanvasText",
  hatDot: "GrayText",
  monocle: "CanvasText",
  glint: "CanvasText",
  shadow: 0,
  glowEnabled: false,
};

/** The palette to paint with: forced colors win over the theme. */
export function davePalette(theme: DaveTheme, forcedColors: boolean): DavePalette {
  if (forcedColors) return DAVE_FORCED_PALETTE;
  return theme === "light" ? DAVE_LIGHT_PALETTE : DAVE_PALETTE;
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a #rgb or #rrggbb colour. */
export function luminance(hex: string): number {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((ch) => ch + ch).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`Not a hex colour: ${hex}`);
  const n = Number.parseInt(h, 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG contrast ratio between two hex colours (1..21). */
export function contrast(fgHex: string, bgHex: string): number {
  const a = luminance(fgHex);
  const b = luminance(bgHex);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
