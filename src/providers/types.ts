/** Server-private provider contracts. Never serialize credentials into API responses. */
export type OpenAIStorageMode = 'keychain' | 'session';
export type OpenAIAuthErrorCode =
  | 'storage_unavailable' | 'invalid_credentials' | 'reconnect_required'
  | 'network_error' | 'invalid_response' | 'login_busy' | 'port_unavailable'
  | 'browser_error' | 'cancelled' | 'login_timeout' | 'provider_denied';

export interface OpenAIConnectionStatus {
  provider: 'openai';
  storage: OpenAIStorageMode;
  state: 'disconnected' | 'connecting' | 'connected' | 'reconnect_required';
  error?: OpenAIAuthErrorCode;
}

/** Only getCredentials() exposes these to the future server-side Codex transport. */
export interface OpenAICodexCredentials {
  accessToken: string;
  accountId: string;
  expiresAt: number;
}

/** A single atomic replacement, never delete-then-write. Internal injection seam. */
export interface OpenAICredentialStore {
  read(): string | null;
  replace(value: string): void;
  delete(): void;
}
