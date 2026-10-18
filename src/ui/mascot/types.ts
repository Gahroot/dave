/**
 * DAVE bot: the contract between the mascot (src/ui/mascot/*) and the voice UI (src/ui/voice/*).
 * Type-only plus constants.
 */
export const DAVE_MOODS = ["idle", "listening", "hearing", "thinking", "speaking", "working", "happy", "sleepy", "oops"] as const;
export type DaveMood = (typeof DAVE_MOODS)[number];

/** Spoken/accessible name for each mood: `DAVE is ${MOOD_LABEL[mood]}`. */
export const MOOD_LABEL: Record<DaveMood, string> = {
  idle: "ready", listening: "listening", hearing: "hearing you", thinking: "thinking", speaking: "talking",
  working: "working on it", happy: "happy", sleepy: "resting", oops: "having trouble",
};

/** Live audio levels, each read once per animation frame. RMS 0..1. */
export type DaveLevels = { input: () => number; output: () => number };

export type DaveMascotProps = {
  mood: DaveMood;
  /** CSS pixels (square). */
  size: number;
  levels?: DaveLevels;
  onPoke?: () => void;
  /** Accessible name; defaults to `DAVE is ${MOOD_LABEL[mood]}`. */
  label?: string;
  className?: string;
};

export type LedTone = "lit" | "dim" | "oops";
export type LedTextProps = {
  text: string;
  tone?: LedTone;
  /** Dot pitch in CSS pixels (default 3). */
  dot?: number;
  /** Accessible text; defaults to `text`. */
  label?: string;
  className?: string;
};
