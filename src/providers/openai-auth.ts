/* PKCE/client protocol adapted from EZ Coder packages/core/src/oauth/openai.ts.
 * MIT, Copyright (c) 2025 KenKai. See openai-auth.LICENSE.
 * No EZ Coder storage, paste-code fallback, or API-key fallback is used.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { credentialStore } from './openai-storage.ts';
import type { OpenAIAuthErrorCode, OpenAIConnectionStatus, OpenAICodexCredentials, OpenAICredentialStore, OpenAIStorageMode } from './types.ts';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const LOGIN_TTL = 5 * 60_000;
const RESPONSE_LIMIT = 64 * 1024;
const messages: Record<OpenAIAuthErrorCode, string> = {
  storage_unavailable: 'Dave Keychain storage is unavailable. Retry or explicitly choose session-only connection.',
  invalid_credentials: 'Saved OpenAI credentials are invalid. Reconnect OpenAI.',
  reconnect_required: 'OpenAI sign-in has expired. Reconnect OpenAI.',
  network_error: 'OpenAI could not be reached. Retry; saved credentials have been preserved.',
  invalid_response: 'OpenAI returned an invalid authentication response.',
  login_busy: 'An OpenAI authentication operation is already running.',
  port_unavailable: 'Dave cannot bind the OpenAI callback port. Finish the other login or free port 1455 and retry.',
  browser_error: 'Dave could not open the browser. Retry sign-in.',
  cancelled: 'OpenAI sign-in was cancelled.',
  login_timeout: 'OpenAI sign-in timed out. Start sign-in again.',
  provider_denied: 'OpenAI sign-in was not approved.',
};
export class OpenAIAuthError extends Error {
  readonly code: OpenAIAuthErrorCode;
  constructor(code: OpenAIAuthErrorCode) { super(messages[code]); this.name = 'OpenAIAuthError'; this.code = code; }
}
const failure = (code: OpenAIAuthErrorCode) => new OpenAIAuthError(code);
const sanitized = (error: unknown) => error instanceof OpenAIAuthError ? error : failure('network_error');

interface StoredCredentials extends OpenAICodexCredentials { refreshToken: string }
/** Trusted server/test dependencies only. Never populate these from HTTP input. */
export interface OpenAIAuthDependencies {
  store?: OpenAICredentialStore;
  fetch?: typeof fetch;
  openBrowser?: (url: string, signal: AbortSignal) => Promise<void>;
  callbackPort?: number;
  loginTimeoutMs?: number;
  networkTimeoutMs?: number;
  now?: () => number;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function secret(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 16_384 && /^[\x21-\x7e]+$/.test(value);
}
function accountId(token: string): string {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw failure('invalid_response');
  try {
    // This is routing metadata from the fixed TLS token endpoint, not local JWT authentication.
    const payload: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    const claim = object(payload) ? payload['https://api.openai.com/auth'] : null;
    const id = object(claim) ? claim.chatgpt_account_id : null;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw failure('invalid_response');
    return id;
  } catch { throw failure('invalid_response'); }
}
function tokenCredentials(data: unknown, now: number): StoredCredentials {
  const allowed = ['access_token', 'refresh_token', 'expires_in', 'token_type', 'id_token', 'scope'];
  if (!object(data) || Object.keys(data).some(key => !allowed.includes(key)) ||
    !secret(data.access_token) || !secret(data.refresh_token) ||
    !Number.isSafeInteger(data.expires_in) || (data.expires_in as number) < 1 || (data.expires_in as number) > 31_536_000 ||
    (data.token_type !== undefined && data.token_type !== 'Bearer' && data.token_type !== 'bearer') ||
    (data.id_token !== undefined && !secret(data.id_token)) ||
    (data.scope !== undefined && (typeof data.scope !== 'string' || data.scope.length > 2048 || !/^[\x20-\x7e]*$/.test(data.scope)))) {
    throw failure('invalid_response');
  }
  return { accessToken: data.access_token, refreshToken: data.refresh_token,
    expiresAt: now + (data.expires_in as number) * 1000, accountId: accountId(data.access_token) };
}
function parseStored(raw: string): StoredCredentials {
  try {
    if (raw.length > RESPONSE_LIMIT) throw failure('invalid_credentials');
    const data: unknown = JSON.parse(raw);
    if (!object(data) || Object.keys(data).sort().join(',') !== 'accessToken,accountId,expiresAt,refreshToken' ||
      !secret(data.accessToken) || !secret(data.refreshToken) || !Number.isSafeInteger(data.expiresAt) ||
      (data.expiresAt as number) <= 0 || accountId(data.accessToken) !== data.accountId) throw failure('invalid_credentials');
    return data as unknown as StoredCredentials;
  } catch { throw failure('invalid_credentials'); }
}

function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(failure('network_error')); };
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
  });
}

function openBrowser(url: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', [url], { signal, timeout: 10_000, maxBuffer: 1024, env: { PATH: '/usr/bin:/bin' } },
      error => error ? reject(failure('browser_error')) : resolve());
  });
}

/** Own one instance per Dave process/account. No routes or UI import this module. */
export class OpenAIAuth {
  #mode: OpenAIStorageMode;
  #store: OpenAICredentialStore;
  #deps: OpenAIAuthDependencies;
  #credentials: StoredCredentials | null = null;
  #loaded = false;
  #error?: OpenAIAuthErrorCode;
  #reconnect = false;
  #login?: AbortController;
  #refresh?: Promise<OpenAICodexCredentials>;
  #refreshController?: AbortController;
  #epoch = 0;

  constructor(mode: OpenAIStorageMode = 'keychain', dependencies: OpenAIAuthDependencies = {}) {
    if (mode !== 'keychain' && mode !== 'session') throw failure('storage_unavailable');
    this.#mode = mode;
    this.#deps = dependencies;
    this.#store = dependencies.store ?? credentialStore(mode);
  }
  status(): OpenAIConnectionStatus {
    return { provider: 'openai', storage: this.#mode,
      state: this.#login ? 'connecting' : this.#reconnect ? 'reconnect_required' : this.#credentials ? 'connected' : 'disconnected',
      ...(this.#error ? { error: this.#error } : {}) };
  }
  /** Explicit startup read; status() itself never touches storage or network. */
  restore(): OpenAIConnectionStatus {
    if (!this.#loaded) {
      try {
        let raw: string | null;
        try { raw = this.#store.read(); } catch { throw failure('storage_unavailable'); }
        this.#credentials = raw === null ? null : parseStored(raw);
        this.#loaded = true;
      } catch (error) { this.#record(error); throw sanitized(error); }
    }
    return this.status();
  }
  #record(error: unknown): void {
    this.#error = sanitized(error).code;
    if (this.#error === 'invalid_credentials' || this.#error === 'reconnect_required') this.#reconnect = true;
  }
  #save(credentials: StoredCredentials): void {
    try { this.#store.replace(JSON.stringify(credentials)); } catch { throw failure('storage_unavailable'); }
    this.#credentials = credentials;
    this.#loaded = true;
    this.#error = undefined;
    this.#reconnect = false;
  }
  cancel(): void { this.#login?.abort(failure('cancelled')); }
  /** Cancels pending work without deleting the persisted connection. */
  dispose(): void {
    this.cancel(); this.#refreshController?.abort(failure('cancelled')); this.#epoch++;
    this.#credentials = null; this.#loaded = false;
    if (this.#mode === 'session') {
      try { this.#store.delete(); } catch { this.#error = 'storage_unavailable'; throw failure('storage_unavailable'); }
    }
  }
  disconnect(): void {
    this.cancel();
    this.#refreshController?.abort(failure('cancelled'));
    this.#epoch++;
    try { this.#store.delete(); } catch { this.#error = 'storage_unavailable'; throw failure('storage_unavailable'); }
    this.#credentials = null; this.#loaded = true; this.#reconnect = false; this.#error = undefined;
  }
  async connect(): Promise<OpenAIConnectionStatus> {
    if (this.#login || this.#refresh) throw failure('login_busy');
    // Check access before launching a browser; malformed old credentials may be replaced by a new login.
    try { this.#store.read(); } catch { this.#error = 'storage_unavailable'; throw failure('storage_unavailable'); }
    const controller = new AbortController();
    this.#login = controller;
    this.#error = undefined;
    const epoch = this.#epoch;
    const timer = setTimeout(() => controller.abort(failure('login_timeout')), Math.min(this.#deps.loginTimeoutMs ?? LOGIN_TTL, LOGIN_TTL));
    try {
      const verifier = randomBytes(32).toString('base64url');
      const state = randomBytes(32).toString('base64url');
      const { code, redirect } = await this.#callback(state, verifier, controller.signal);
      const credentials = await this.#tokens({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect }, controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (epoch !== this.#epoch) throw failure('cancelled');
      this.#save(credentials);
    } catch (error) { this.#record(error); throw sanitized(error); }
    finally { clearTimeout(timer); controller.abort(); this.#login = undefined; }
    return this.status();
  }
  /** Server-private: refresh tokens never leave this class. Requires validated Codex account routing. */
  async getCredentials(): Promise<OpenAICodexCredentials> {
    if (this.#login) throw failure('login_busy');
    this.restore();
    if (this.#reconnect || !this.#credentials) throw failure('reconnect_required');
    const current = this.#credentials;
    const expose = (value: StoredCredentials): OpenAICodexCredentials => ({ accessToken: value.accessToken, accountId: value.accountId, expiresAt: value.expiresAt });
    if (current.expiresAt > (this.#deps.now ?? Date.now)() + 60_000) return expose(current);
    if (!this.#refresh) {
      const epoch = this.#epoch;
      const controller = new AbortController();
      this.#refreshController = controller;
      this.#refresh = (async () => {
        try {
          const next = await this.#tokens({ grant_type: 'refresh_token', refresh_token: current.refreshToken }, controller.signal);
          if (epoch !== this.#epoch) throw failure('cancelled');
          if (next.accountId !== current.accountId) throw failure('invalid_response');
          this.#save(next);
          return expose(next);
        } catch (error) { if (epoch === this.#epoch) this.#record(error); throw sanitized(error); }
        finally { this.#refresh = undefined; this.#refreshController = undefined; }
      })();
    }
    return this.#refresh;
  }
  async #tokens(fields: Record<string, string>, parent?: AbortSignal): Promise<StoredCredentials> {
    const timeout = AbortSignal.timeout(Math.min(this.#deps.networkTimeoutMs ?? 15_000, 15_000));
    const signal = parent ? AbortSignal.any([parent, timeout]) : timeout;
    try {
      const response = await bounded((this.#deps.fetch ?? fetch)(TOKEN_URL, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ client_id: CLIENT_ID, ...fields }),
      }), signal);
      if (!response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
        void response.body?.cancel().catch(() => {});
        throw failure('invalid_response');
      }
      const reader = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const { value, done } = await bounded(reader.read(), signal);
          if (done) break;
          size += value.byteLength;
          if (size > RESPONSE_LIMIT) throw failure('invalid_response');
          chunks.push(value);
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (signal.aborted) throw failure('network_error');
      let data: unknown;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('invalid_response'); }
      if (!response.ok) {
        if (response.status === 400 && object(data) && data.error === 'invalid_grant') throw failure('reconnect_required');
        throw failure('network_error');
      }
      return tokenCredentials(data, (this.#deps.now ?? Date.now)());
    } catch (error) {
      if (parent?.aborted) throw parent.reason;
      throw sanitized(error);
    }
  }
  #callback(state: string, verifier: string, signal: AbortSignal): Promise<{ code: string; redirect: string }> {
    return new Promise((resolve, reject) => {
      let used = false;
      let settled = false;
      let redirect = '';
      let host = '';
      const cleanup = () => { signal.removeEventListener('abort', aborted); server.close(); server.closeAllConnections(); };
      const finish = (error?: OpenAIAuthError, code?: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve({ code: code!, redirect });
      };
      const aborted = () => finish(signal.reason instanceof OpenAIAuthError ? signal.reason : failure('cancelled'));
      const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Connection', 'close');
        const rejectRequest = () => { res.writeHead(400); res.end('Invalid authentication callback.'); };
        if (used || signal.aborted || req.method !== 'GET' || req.headers.host !== host ||
          req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index]!.toLowerCase() === 'host').length !== 1 ||
          !req.url || req.url.length > 8192 || !req.url.startsWith('/auth/callback?')) { rejectRequest(); return; }
        const url = new URL(req.url, `http://${host}`);
        const params = url.searchParams;
        const allowed = ['state', 'code', 'error', 'error_description', 'error_uri'];
        const receivedState = params.get('state') ?? '';
        if (url.pathname !== '/auth/callback' || url.hash || [...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1) ||
          !/^[A-Za-z0-9_-]{43}$/.test(receivedState) || !timingSafeEqual(Buffer.from(receivedState), Buffer.from(state)) ||
          [...params.values()].some(value => value.length > 4096 || /[\x00-\x1f\x7f]/.test(value))) { rejectRequest(); return; }
        const code = params.get('code');
        const error = params.get('error');
        if ((code === null) === (error === null) || (code !== null && (!/^[A-Za-z0-9._~-]{1,4096}$/.test(code) || params.has('error_description') || params.has('error_uri'))) ||
          (error !== null && !['access_denied', 'temporarily_unavailable', 'server_error', 'invalid_request', 'unauthorized_client', 'unsupported_response_type', 'invalid_scope', 'interaction_required', 'login_required', 'consent_required'].includes(error))) { rejectRequest(); return; }
        used = true;
        res.end(error ? 'Sign-in was not approved. Return to Dave.' : 'Callback received. Return to Dave to check connection status.', () => {
          finish(error ? failure('provider_denied') : undefined, code ?? undefined);
        });
      });
      server.requestTimeout = 5000;
      server.headersTimeout = 5000;
      server.on('error', () => finish(failure('port_unavailable')));
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) { aborted(); return; }
      server.listen(this.#deps.callbackPort ?? 1455, '127.0.0.1', () => {
        if (settled || signal.aborted) { cleanup(); return; }
        const address = server.address();
        if (!address || typeof address === 'string') { finish(failure('port_unavailable')); return; }
        host = `localhost:${address.port}`;
        redirect = `http://${host}/auth/callback`;
        const url = new URL(AUTHORIZE_URL);
        url.search = new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirect,
          scope: 'openid profile email offline_access', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256', state, prompt: 'login', id_token_add_organizations: 'true',
          codex_cli_simplified_flow: 'true', originator: 'dave' }).toString();
        Promise.resolve().then(() => {
          if (!signal.aborted && !settled) return (this.#deps.openBrowser ?? openBrowser)(url.toString(), signal);
        }).catch(() => finish(failure('browser_error')));
      });
    });
  }
}
