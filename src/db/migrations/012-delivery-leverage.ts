import type { Db } from "../index.ts";

/**
 * Delivery leverage: lanes, task goals, verification and "sent" times on items; confirmation, schedule
 * and delivery-step marks on outcomes. Additive only (new nullable or defaulted columns).
 *
 * Backfill approximations (documented in README):
 * - items already verified get verified_at = updated_at (the real verification time was never stored);
 * - every existing outcome row was written by a person (putOutcome or an accepted draft), so it counts as
 *   a confirmed finish line with confirmed_at = updated_at.
 */
export function migrateDeliveryLeverage(db: Db): void {
  db.exec(`
    ALTER TABLE intel_items ADD COLUMN lane TEXT CHECK(lane IS NULL OR lane IN ('finish_line','extra','phase2'));
    ALTER TABLE intel_items ADD COLUMN goal TEXT;
    ALTER TABLE intel_items ADD COLUMN verified_at TEXT;
    ALTER TABLE intel_items ADD COLUMN sent_at TEXT;
    ALTER TABLE intel_items ADD COLUMN reopen_count INTEGER NOT NULL DEFAULT 0 CHECK(reopen_count >= 0);
    UPDATE intel_items SET verified_at = updated_at WHERE evidence_state = 'verified';
    ALTER TABLE intel_outcomes ADD COLUMN confirmed_at TEXT;
    ALTER TABLE intel_outcomes ADD COLUMN start_date TEXT;
    ALTER TABLE intel_outcomes ADD COLUMN target_date TEXT;
    ALTER TABLE intel_outcomes ADD COLUMN live_at TEXT;
    ALTER TABLE intel_outcomes ADD COLUMN using_at TEXT;
    ALTER TABLE intel_outcomes ADD COLUMN signed_off_at TEXT;
    ALTER TABLE intel_outcomes ADD COLUMN last_demo_at TEXT;
    UPDATE intel_outcomes SET confirmed_at = updated_at;
  `);
}
