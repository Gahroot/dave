import { createRequire } from 'node:module';
import type { Entry } from '@napi-rs/keyring';

const require = createRequire(import.meta.url);

/** The Fathom API key lives only in the macOS Keychain, never in the database, logs or responses. */
export const FATHOM_KEYCHAIN = { service: 'com.dave.meetings.fathom', account: 'api-key' } as const;

/** The part of a Keychain entry DAVE uses. Tests inject an in-memory entry. */
export interface SecretEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
  deleteCredential(): boolean;
}

export interface FathomKeyStore {
  /** The saved key, or null when none is saved. Throws when secure storage cannot be used. */
  read(): string | null;
  /** Validates, then saves. Throws with a message that never contains the key. */
  replace(key: string): void;
  delete(): void;
}

export type KeyCheck = { ok: true; value: string } | { ok: false; error: string };

/** Checks a pasted key without echoing it back. The webhook secret is rejected by name. */
export function checkFathomKey(input: unknown): KeyCheck {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, error: 'Paste your Fathom API key' };
  const value = input.trim();
  if (value.startsWith('whsec_')) return { ok: false, error: 'That is the webhook secret, not the API key' };
  if (value.length < 16 || value.length > 512 || !/^[\x21-\x7e]+$/.test(value)) {
    return { ok: false, error: 'That does not look like a Fathom API key' };
  }
  return { ok: true, value };
}

function openKeychainEntry(): SecretEntry {
  const native = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring');
  const entry: Entry = new native.Entry(FATHOM_KEYCHAIN.service, FATHOM_KEYCHAIN.account);
  return entry;
}

/**
 * Lazy: creating the store never opens or changes a Keychain entry. macOS only;
 * everywhere else every call fails closed instead of falling back to a file.
 */
export function fathomKeyStore(
  open: () => SecretEntry = openKeychainEntry,
  platform: NodeJS.Platform = process.platform,
): FathomKeyStore {
  let entry: SecretEntry | undefined;
  const get = (): SecretEntry => {
    if (platform !== 'darwin') throw new Error('Secure storage unavailable');
    entry ??= open();
    return entry;
  };
  return {
    read: () => {
      const value = get().getPassword();
      return value ? value : null;
    },
    replace: key => {
      const checked = checkFathomKey(key);
      if (!checked.ok) throw new Error(checked.error);
      get().setPassword(checked.value);
    },
    delete: () => { get().deleteCredential(); },
  };
}

/** An in-memory store for tests and for callers that must never touch the Keychain. */
export function memoryKeyStore(initial: string | null = null): FathomKeyStore {
  let value = initial;
  return {
    read: () => value,
    replace: key => {
      const checked = checkFathomKey(key);
      if (!checked.ok) throw new Error(checked.error);
      value = checked.value;
    },
    delete: () => { value = null; },
  };
}
