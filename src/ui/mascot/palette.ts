/** DAVE bot colours: violet LEDs on a near-black stage ("violet = DAVE"). */
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
  glowEnabled: false,
};

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
