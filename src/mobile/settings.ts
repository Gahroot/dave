import type { Db } from "../db/index.ts";

/** Non-secret phone access switch. The key itself never touches SQLite. */
export interface MobileSettings {
  enabled(): boolean;
  setEnabled(enabled: boolean): void;
}

/**
 * Additive and idempotent: the table is created on first use, like an optional
 * feature, so no schema version bump or backup migration is needed.
 */
export function mobileSettings(db: Db): MobileSettings {
  db.exec(`CREATE TABLE IF NOT EXISTS mobile_settings (
    id INTEGER PRIMARY KEY CHECK(id=1),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1))
  );
  INSERT OR IGNORE INTO mobile_settings(id) VALUES(1);`);
  return {
    enabled: () => (db.prepare("SELECT enabled FROM mobile_settings WHERE id = 1").get() as { enabled: number } | undefined)?.enabled === 1,
    setEnabled: (enabled) => { db.prepare("UPDATE mobile_settings SET enabled = ? WHERE id = 1").run(enabled ? 1 : 0); },
  };
}

export function memoryMobileSettings(initial = false): MobileSettings {
  let value = initial;
  return { enabled: () => value, setEnabled: (enabled) => { value = enabled; } };
}
