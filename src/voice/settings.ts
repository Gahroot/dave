import type { Db } from "../db/index.ts";
import { DEFAULT_VOICE_SETTINGS, MODELS, VOICES, VOICE_MODES, VOICE_THEMES, type VoiceSettings } from "./types.ts";

export type SettingsResult = { ok: true; settings: VoiceSettings } | { ok: false; message: string };

type Row = { voice: string; model: string; greeting: number; mode: string; sounds: number; theme: string };

/** Voice is off when DAVE_VOICE=off (case-insensitive). */
export function voiceDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.DAVE_VOICE ?? "").trim().toLowerCase() === "off";
}

const KEYS = ["voice", "model", "greeting", "mode", "sounds", "theme"] as const;

/** Strict: every field optional, unknown keys and wrong types rejected. */
export function validateSettingsPatch(input: unknown): { ok: true; patch: Partial<VoiceSettings> } | { ok: false; message: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, message: "Settings must be an object." };
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((k) => !(KEYS as readonly string[]).includes(k))) return { ok: false, message: "Unknown setting." };
  const patch: Partial<VoiceSettings> = {};
  if (raw.voice !== undefined) {
    const v = VOICES.find((x) => x === raw.voice);
    if (!v) return { ok: false, message: "Unknown voice." };
    patch.voice = v;
  }
  if (raw.model !== undefined) {
    const m = MODELS.find((x) => x === raw.model);
    if (!m) return { ok: false, message: "Unknown model." };
    patch.model = m;
  }
  if (raw.mode !== undefined) {
    const m = VOICE_MODES.find((x) => x === raw.mode);
    if (!m) return { ok: false, message: "Unknown mode." };
    patch.mode = m;
  }
  if (raw.theme !== undefined) {
    const t = VOICE_THEMES.find((x) => x === raw.theme);
    if (!t) return { ok: false, message: "Unknown theme." };
    patch.theme = t;
  }
  for (const key of ["greeting", "sounds"] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v !== "boolean") return { ok: false, message: `${key} must be true or false.` };
    patch[key] = v;
  }
  return { ok: true, patch };
}

export function voiceSettingsStore(db: Db, now: () => Date) {
  function get(): VoiceSettings {
    const row = db.prepare("SELECT voice, model, greeting, mode, sounds, theme FROM voice_settings WHERE id=1").get() as Row | undefined;
    if (!row) return { ...DEFAULT_VOICE_SETTINGS };
    return {
      voice: VOICES.find((v) => v === row.voice) ?? DEFAULT_VOICE_SETTINGS.voice,
      model: MODELS.find((m) => m === row.model) ?? DEFAULT_VOICE_SETTINGS.model,
      greeting: row.greeting === 1,
      mode: VOICE_MODES.find((m) => m === row.mode) ?? DEFAULT_VOICE_SETTINGS.mode,
      sounds: row.sounds === 1,
      theme: VOICE_THEMES.find((t) => t === row.theme) ?? DEFAULT_VOICE_SETTINGS.theme,
    };
  }
  function save(input: unknown): SettingsResult {
    const checked = validateSettingsPatch(input);
    if (!checked.ok) return checked;
    const next: VoiceSettings = { ...get(), ...checked.patch };
    db.prepare(`INSERT INTO voice_settings(id, voice, model, greeting, mode, sounds, theme, updated_at) VALUES (1,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET voice=excluded.voice, model=excluded.model, greeting=excluded.greeting, mode=excluded.mode, sounds=excluded.sounds, theme=excluded.theme, updated_at=excluded.updated_at`)
      .run(next.voice, next.model, next.greeting ? 1 : 0, next.mode, next.sounds ? 1 : 0, next.theme, now().toISOString());
    return { ok: true, settings: next };
  }
  return { get, save };
}
export type VoiceSettingsStore = ReturnType<typeof voiceSettingsStore>;
