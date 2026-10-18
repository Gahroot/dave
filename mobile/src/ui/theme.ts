/**
 * Design tokens, mirrored from the web workbench (src/ui/styles.css,
 * src/ui/theme.ts, DESIGN.md). Same meaning per tone:
 * amber your move · blue working · green done · red broken · gray parked · violet DAVE's guess.
 * Tones color icons, tiles and 3px rails — never body text (contrast).
 */
import type { Tone } from "../../../src/ui/status.ts";

export const colors = {
  canvas: "#f2f4f7",
  wash: "#e6edf9",
  surface: "#ffffff",
  sunken: "#f5f6f8",
  selected: "#edf0f4",
  ink: "#202630",
  muted: "#526070",
  border: "#dce0e5",
  panelBorder: "#e0e4ea",
  control: "#768293",
  accent: "#1859b7",
  onAccent: "#ffffff",
  danger: "#c92a2a",
  onDanger: "#ffffff",
} as const;

export const tones: Readonly<Record<Tone, string>> = {
  amber: "#b45309", blue: "#1859b7", green: "#198038", red: "#c92a2a", gray: "#6a7584", violet: "#6741d9",
};
export const tints: Readonly<Record<Tone, string>> = {
  amber: "#fdf3e7", blue: "#ebf2fc", green: "#eef8f1", red: "#fdecec", gray: "#eef0f3", violet: "#f1edfd",
};
/** Tones that ask for the owner or flag a failure get a row rail; calm states do not. */
export const railTones: ReadonlySet<Tone> = new Set<Tone>(["amber", "red", "violet"]);

export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 6, md: 8, lg: 12, pill: 999 } as const;
/** Minimum touch target (DESIGN.md: 44px touch). */
export const touch = 44;
export const rail = 3;

export const text = {
  title: { fontSize: 24, lineHeight: 30, fontWeight: "600", letterSpacing: -0.5, color: colors.ink },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: "600", letterSpacing: -0.3, color: colors.ink },
  subheading: { fontSize: 16, lineHeight: 22, fontWeight: "600", color: colors.ink },
  body: { fontSize: 16, lineHeight: 22, color: colors.ink },
  small: { fontSize: 14, lineHeight: 20, color: colors.ink },
  muted: { fontSize: 14, lineHeight: 20, color: colors.muted },
  caption: { fontSize: 12, lineHeight: 16, color: colors.muted },
  mono: { fontSize: 13, lineHeight: 18, fontFamily: "Menlo", color: colors.ink },
} as const;

export const shadow = {
  shadowColor: "#1b2433",
  shadowOpacity: 0.06,
  shadowRadius: 6,
  shadowOffset: { width: 0, height: 1 },
  elevation: 1,
} as const;
