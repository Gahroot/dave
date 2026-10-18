import type { Db } from "../index.ts";

/**
 * Voice theme: display-only preference ("dark" | "light") on the single voice settings row.
 * Additive only (one new column with a default). Existing rows keep every value and read as "dark".
 */
export function migrateVoiceTheme(db: Db): void {
  db.exec(`ALTER TABLE voice_settings ADD COLUMN theme TEXT NOT NULL DEFAULT 'dark' CHECK(theme IN ('dark','light'));`);
}
