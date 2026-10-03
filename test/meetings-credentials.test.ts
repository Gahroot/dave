import { describe, expect, it } from 'vitest';
import { checkFathomKey, fathomKeyStore, type SecretEntry } from '../src/meetings/credentials.ts';

function fakeEntry(): SecretEntry & { value: string | null; opened: number } {
  const entry = {
    value: null as string | null,
    opened: 0,
    getPassword: () => entry.value,
    setPassword: (v: string) => { entry.value = v; },
    deleteCredential: () => { const had = entry.value !== null; entry.value = null; return had; },
  };
  return entry;
}

const KEY = 'fathom-test-key-0123456789abcdef';

describe('Fathom key storage', () => {
  it('does not open the Keychain until the key is used', () => {
    const entry = fakeEntry();
    let opens = 0;
    const store = fathomKeyStore(() => { opens++; return entry; }, 'darwin');
    expect(opens).toBe(0);
    expect(store.read()).toBeNull();
    store.replace(KEY);
    expect(opens).toBe(1);
  });

  it('reads, replaces and deletes the key', () => {
    const entry = fakeEntry();
    const store = fathomKeyStore(() => entry, 'darwin');
    store.replace(`  ${KEY}\n`);
    expect(entry.value).toBe(KEY);
    expect(store.read()).toBe(KEY);
    store.replace(`${KEY}-2`);
    expect(store.read()).toBe(`${KEY}-2`);
    store.delete();
    expect(store.read()).toBeNull();
    expect(() => store.delete()).not.toThrow();
  });

  it('fails closed away from macOS without touching any storage', () => {
    let opens = 0;
    const store = fathomKeyStore(() => { opens++; return fakeEntry(); }, 'linux');
    expect(() => store.read()).toThrow('Secure storage unavailable');
    expect(() => store.replace(KEY)).toThrow('Secure storage unavailable');
    expect(() => store.delete()).toThrow('Secure storage unavailable');
    expect(opens).toBe(0);
  });

  it('rejects bad keys with messages that never repeat the input', () => {
    const entry = fakeEntry();
    const store = fathomKeyStore(() => entry, 'darwin');
    const secret = 'whsec_abcdefghijklmnopqrstuvwxyz';
    expect(() => store.replace(secret)).toThrow('webhook secret');
    try { store.replace(secret); } catch (e) { expect(String(e)).not.toContain('abcdefghij'); }
    expect(entry.value).toBeNull();
  });

  it.each([
    [undefined, false],
    ['', false],
    ['short', false],
    ['has a space in the middle of it', false],
    ['x'.repeat(513), false],
    ['whsec_0123456789abcdefghij', false],
    [KEY, true],
  ])('checks %j', (input, ok) => {
    expect(checkFathomKey(input).ok).toBe(ok);
  });
});
