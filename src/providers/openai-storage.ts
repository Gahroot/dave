import { createRequire } from 'node:module';
import type { Entry } from '@napi-rs/keyring';
import type { OpenAICredentialStore, OpenAIStorageMode } from './types.ts';

const require = createRequire(import.meta.url);

/** Lazy: importing the auth module never opens or changes a keychain entry. */
export function credentialStore(mode: OpenAIStorageMode): OpenAICredentialStore {
  if (mode === 'session') {
    let value: string | null = null;
    return { read: () => value, replace: next => { value = next; }, delete: () => { value = null; } };
  }
  let entry: Entry | undefined;
  const getEntry = (): Entry => {
    if (process.platform !== 'darwin') throw new Error('Secure storage unavailable');
    if (!entry) {
      const native = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring');
      entry = new native.Entry('com.dave.providers.openai', 'oauth');
    }
    return entry;
  };
  return {
    read: () => getEntry().getPassword(),
    replace: value => getEntry().setPassword(value),
    delete: () => { getEntry().deleteCredential(); },
  };
}
