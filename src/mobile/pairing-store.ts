import { createRequire } from "node:module";
import type { Entry } from "@napi-rs/keyring";
import type { SecretEntry } from "../meetings/credentials.ts";

const require = createRequire(import.meta.url);

/** The pairing root key lives only in the macOS Keychain, never in the database, logs or responses. */
export const PAIRING_KEYCHAIN = { service: "com.dave.mobile.pairing", account: "pairing" } as const;

export type PairingRecord = { v: 1; key: string; createdAt: string; claimedBy?: string; claimedAt?: string };

export interface PairingStore {
  /** The saved pairing, or null when none (or a malformed one) is saved. Throws when secure storage cannot be used. */
  read(): PairingRecord | null;
  write(record: PairingRecord): void;
  delete(): void;
}

const isIso = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));

/** Strict shape check; anything else is treated as no pairing. */
export function parsePairingRecord(value: unknown): PairingRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (Object.keys(r).some((key) => !["v", "key", "createdAt", "claimedBy", "claimedAt"].includes(key))) return null;
  if (r.v !== 1 || typeof r.key !== "string" || !/^[0-9a-f]{64}$/.test(r.key) || !isIso(r.createdAt)) return null;
  const record: PairingRecord = { v: 1, key: r.key, createdAt: r.createdAt };
  if (r.claimedBy !== undefined || r.claimedAt !== undefined) {
    if (typeof r.claimedBy !== "string" || !/^phone-[0-9a-f]{32}$/.test(r.claimedBy) || !isIso(r.claimedAt)) return null;
    record.claimedBy = r.claimedBy;
    record.claimedAt = r.claimedAt;
  }
  return record;
}

function decode(text: string | null): PairingRecord | null {
  if (!text) return null;
  try { return parsePairingRecord(JSON.parse(text)); } catch { return null; }
}
function encode(record: PairingRecord): string {
  const checked = parsePairingRecord(record);
  if (!checked) throw new Error("Invalid pairing record");
  return JSON.stringify(checked);
}

function openKeychainEntry(): SecretEntry {
  const native = require("@napi-rs/keyring") as typeof import("@napi-rs/keyring");
  const entry: Entry = new native.Entry(PAIRING_KEYCHAIN.service, PAIRING_KEYCHAIN.account);
  return entry;
}

/**
 * Lazy: creating the store never opens or changes a Keychain entry. macOS only;
 * everywhere else every call fails closed instead of falling back to a file.
 */
export function pairingStore(
  open: () => SecretEntry = openKeychainEntry,
  platform: NodeJS.Platform = process.platform,
): PairingStore {
  let entry: SecretEntry | undefined;
  const get = (): SecretEntry => {
    if (platform !== "darwin") throw new Error("Secure storage unavailable");
    entry ??= open();
    return entry;
  };
  return {
    read: () => decode(get().getPassword()),
    write: (record) => { get().setPassword(encode(record)); },
    delete: () => { get().deleteCredential(); },
  };
}

/** An in-memory store for tests and for callers that must never touch the Keychain. */
export function memoryPairingStore(initial: PairingRecord | null = null): PairingStore {
  let value = initial ? encode(initial) : null;
  return {
    read: () => decode(value),
    write: (record) => { value = encode(record); },
    delete: () => { value = null; },
  };
}
