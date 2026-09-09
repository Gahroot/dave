import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { OpenAIAuth } from '../src/providers/openai-auth.ts';
import type { OpenAIAuthDependencies } from '../src/providers/openai-auth.ts';
import type { OpenAICredentialStore } from '../src/providers/types.ts';

const jwt = (id = 'account_test') => `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: id } })).toString('base64url')}.signature`;
const tokens = (extra = {}) => ({ access_token: jwt(), refresh_token: 'refresh_private', expires_in: 3600, token_type: 'Bearer', ...extra });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function store(initial: string | null = null) {
  let value = initial;
  return { read: vi.fn(() => value), replace: vi.fn((next: string) => { value = next; }), delete: vi.fn(() => { value = null; }) } satisfies OpenAICredentialStore;
}
const saved = (expiresAt = 1) => JSON.stringify({ accessToken: jwt(), refreshToken: 'old_refresh', accountId: 'account_test', expiresAt });
function callback(authUrl: string, query?: string, headers?: Record<string, string>, path?: string, method = 'GET'): Promise<number> {
  const auth = new URL(authUrl);
  const redirect = new URL(auth.searchParams.get('redirect_uri')!);
  const target = path ?? `${redirect.pathname}?${query ?? new URLSearchParams({ state: auth.searchParams.get('state')!, code: 'authorization_code' })}`;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: redirect.port, path: target, method, headers: { Host: redirect.host, ...headers } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject); req.end();
  });
}
function setup(deps: OpenAIAuthDependencies = {}) {
  const storage = store();
  const network = vi.fn<typeof fetch>(async () => response(tokens()));
  const auth = new OpenAIAuth('session', { store: storage, fetch: network, callbackPort: 0,
    openBrowser: async url => { expect(await callback(url)).toBe(200); }, ...deps });
  return { auth, storage, network };
}

describe('Dave-owned OpenAI auth (synthetic credentials and ephemeral listeners only)', () => {
  it('uses ready loopback listener, fixed endpoints, S256, form exchange, and sanitized status', async () => {
    let launch = '';
    const { auth, storage, network } = setup({ openBrowser: async url => { launch = url; expect(await callback(url)).toBe(200); } });
    expect(await auth.connect()).toEqual({ provider: 'openai', storage: 'session', state: 'connected' });
    const url = new URL(launch);
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize');
    expect(url.searchParams.get('scope')).toBe('openid profile email offline_access');
    const [endpoint, init] = network.mock.calls[0]!;
    expect(endpoint).toBe('https://auth.openai.com/oauth/token');
    expect(init?.redirect).toBe('error');
    const fields = init!.body as URLSearchParams;
    expect(fields.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(fields.get('grant_type')).toBe('authorization_code');
    expect(fields.get('redirect_uri')).toBe(url.searchParams.get('redirect_uri'));
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(fields.get('code_verifier')!).digest('base64url'));
    expect(storage.replace).toHaveBeenCalledTimes(1);
    expect(await auth.getCredentials()).toEqual({ accessToken: jwt(), accountId: 'account_test', expiresAt: expect.any(Number) });
    expect(JSON.stringify(auth.status())).not.toMatch(/account_test|refresh_private|header|authorization_code/);
    await expect(callback(launch)).rejects.toThrow();
  });

  it('rejects wrong host/path/state, duplicate fields, Unicode, unknown params and methods without consuming login', async () => {
    const { auth, network } = setup({ openBrowser: async url => {
      const state = new URL(url).searchParams.get('state')!;
      for (const query of [`state=wrong&code=abc`, `state=${state}&code=a&code=b`, `state=${state}&state=${state}&code=a`,
        `state=${state}&code=a&extra=b`, `state=${'é'.repeat(43)}&code=a`, `state=${state}&code=a&error=access_denied`,
        `state=${state}&code=`, `state=${state}&error=unknown`, `state=${state}&code=a&error_description=x`]) {
        expect(await callback(url, query)).toBe(400);
      }
      expect(await callback(url, undefined, { Host: 'evil.example' })).toBe(400);
      expect(await callback(url, undefined, undefined, '/other')).toBe(400);
      expect(await callback(url, undefined, undefined, undefined, 'POST')).toBe(400);
      expect(await callback(url)).toBe(200);
    } });
    await auth.connect(); expect(network).toHaveBeenCalledTimes(1);
  });

  it.each(['access_denied', 'server_error'])('handles provider %s without exchanging or reflecting details', async error => {
    const { auth, network } = setup({ openBrowser: async url => {
      const state = new URL(url).searchParams.get('state')!;
      await callback(url, new URLSearchParams({ state, error, error_description: 'private_details' }).toString());
    } });
    await expect(auth.connect()).rejects.toMatchObject({ code: 'provider_denied' });
    expect(network).not.toHaveBeenCalled(); expect(JSON.stringify(auth.status())).not.toContain('private_details');
  });

  it('handles cancellation, TTL, browser failure and closes only its own listener', async () => {
    for (const action of ['cancel', 'timeout', 'browser'] as const) {
      let launch = '';
      const { auth, network } = setup({ loginTimeoutMs: 30, openBrowser: async url => {
        launch = url;
        if (action === 'cancel') auth.cancel();
        if (action === 'browser') throw new Error('sensitive browser failure');
      } });
      await expect(auth.connect()).rejects.toMatchObject({ code: action === 'cancel' ? 'cancelled' : action === 'timeout' ? 'login_timeout' : 'browser_error' });
      expect(network).not.toHaveBeenCalled(); await expect(callback(launch)).rejects.toThrow();
    }
  });

  it('does not launch browser or close another listener on port collision', async () => {
    const other = createServer((_, res) => res.end('owned by someone else'));
    await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve));
    try {
      const address = other.address() as { port: number };
      const browser = vi.fn();
      const { auth } = setup({ callbackPort: address.port, openBrowser: browser });
      await expect(auth.connect()).rejects.toMatchObject({ code: 'port_unavailable' });
      expect(browser).not.toHaveBeenCalled(); expect(other.listening).toBe(true);
    } finally { await new Promise<void>(resolve => other.close(() => resolve())); }
  });

  it('deduplicates refresh, rotates atomically and keeps refresh credentials server-private', async () => {
    const storage = store(saved());
    const { auth, network } = setup({ store: storage });
    const credentials = await Promise.all([auth.getCredentials(), auth.getCredentials(), auth.getCredentials()]);
    expect(network).toHaveBeenCalledTimes(1); expect(storage.replace).toHaveBeenCalledTimes(1);
    expect(storage.delete).not.toHaveBeenCalled(); expect(credentials[0]).not.toHaveProperty('refreshToken');
    expect((network.mock.calls[0]![1]!.body as URLSearchParams).get('refresh_token')).toBe('old_refresh');
    expect(JSON.parse(storage.read()!).refreshToken).toBe('refresh_private');
  });

  it.each([500, 429])('preserves usable saved refresh on HTTP %s and releases lock for retry', async status => {
    const storage = store(saved());
    let fail = true;
    const network = vi.fn<typeof fetch>(async () => fail ? response({ error: 'private_provider_details' }, status) : response(tokens()));
    const { auth } = setup({ store: storage, fetch: network });
    await expect(auth.getCredentials()).rejects.toMatchObject({ code: 'network_error' });
    expect(storage.read()).toBe(saved()); expect(storage.delete).not.toHaveBeenCalled();
    fail = false; await auth.getCredentials(); expect(network).toHaveBeenCalledTimes(2);
  });

  it('invalid_grant requires reconnect without deleting credentials or retry loops', async () => {
    const storage = store(saved());
    const network = vi.fn<typeof fetch>(async () => response({ error: 'invalid_grant', error_description: 'private' }, 400));
    const { auth } = setup({ store: storage, fetch: network });
    await expect(auth.getCredentials()).rejects.toMatchObject({ code: 'reconnect_required' });
    await expect(auth.getCredentials()).rejects.toMatchObject({ code: 'reconnect_required' });
    expect(network).toHaveBeenCalledTimes(1); expect(storage.read()).toBe(saved());
    expect(auth.status().state).toBe('reconnect_required');
  });

  it.each([{ access_token: 'not-jwt' }, { access_token: jwt('bad/id') }, { refresh_token: '' }, { expires_in: -1 },
    { expires_in: '3600' }, { token_type: 'Basic' }, { unexpected: 'value' }, { access_token: jwt('different_account') }])('rejects malformed tokens or changed account: %j', async extra => {
    const storage = store(saved());
    const { auth } = setup({ store: storage, fetch: async () => response(tokens(extra)) });
    await expect(auth.getCredentials()).rejects.toMatchObject({ code: 'invalid_response' });
    expect(storage.read()).toBe(saved()); expect(storage.replace).not.toHaveBeenCalled();
  });

  it('bounds response bytes, fetch and streamed body time; redacts raw network errors', async () => {
    const networks: Array<typeof fetch> = [
      async () => response({ huge: 'x'.repeat(70_000) }),
      async () => new Response('not json', { headers: { 'content-type': 'application/json' } }),
      async () => new Promise(() => {}),
      async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } }),
      async () => { throw new Error('raw token_private'); },
    ];
    for (const network of networks) {
      const storage = store(saved());
      const { auth } = setup({ store: storage, fetch: network, networkTimeoutMs: 20 });
      await expect(auth.getCredentials()).rejects.toBeInstanceOf(Error);
      expect(JSON.stringify(auth.status())).not.toContain('token_private'); expect(storage.read()).toBe(saved());
    }
  });

  it('fails closed on storage failure, with session-only explicitly selected and no native operations', async () => {
    const unavailable = { read() { throw new Error('private keychain details'); }, replace() { throw new Error('private'); }, delete() {} };
    const browser = vi.fn();
    const auth = new OpenAIAuth('keychain', { store: unavailable, openBrowser: browser });
    expect(auth.status().storage).toBe('keychain');
    await expect(auth.connect()).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(browser).not.toHaveBeenCalled();
    expect(() => auth.restore()).toThrow('Dave Keychain storage is unavailable');
    const session = setup({ store: undefined });
    await session.auth.connect(); expect(session.auth.status().storage).toBe('session');
    session.auth.disconnect(); expect(session.auth.status().state).toBe('disconnected');
  });

  it('preserves old credentials on replacement failure and rejects corrupted persisted records', async () => {
    const storage = store(saved());
    storage.replace.mockImplementation(() => { throw new Error('private'); });
    const { auth } = setup({ store: storage });
    await expect(auth.getCredentials()).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(storage.read()).toBe(saved());
    const corrupt = setup({ store: store('{"refreshToken":"private"}') });
    await expect(corrupt.auth.getCredentials()).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(corrupt.network).not.toHaveBeenCalled();
  });

  it('cancels token exchange, rejects concurrent login and never persists its late result', async () => {
    let release!: (response: Response) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const { auth, storage } = setup({ fetch: async () => { started(); return new Promise(resolve => { release = resolve; }); } });
    const login = auth.connect(); await ready;
    await expect(auth.connect()).rejects.toMatchObject({ code: 'login_busy' });
    auth.cancel();
    await expect(login).rejects.toMatchObject({ code: 'cancelled' });
    release(response(tokens()));
    await Promise.resolve();
    expect(storage.replace).not.toHaveBeenCalled();
    expect(auth.status().state).toBe('disconnected');
  });

  it('shuts down a pending refresh without waiting for an uncooperative network', async () => {
    const storage = store(saved());
    const { auth } = setup({ store: storage, fetch: async () => new Promise(() => {}) });
    const refresh = auth.getCredentials();
    auth.dispose();
    await expect(refresh).rejects.toMatchObject({ code: 'cancelled' });
    expect(storage.replace).not.toHaveBeenCalled();
  });

  it('prevents cancellation/disconnect late responses from writing credentials and rejects overlapping login', async () => {
    let release!: (response: Response) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const storage = store(saved());
    const { auth } = setup({ store: storage, fetch: async () => { started(); return new Promise(resolve => { release = resolve; }); } });
    const refresh = auth.getCredentials(); await ready;
    await expect(auth.connect()).rejects.toMatchObject({ code: 'login_busy' });
    auth.disconnect(); release(response(tokens()));
    await expect(refresh).rejects.toMatchObject({ code: 'cancelled' });
    expect(storage.replace).not.toHaveBeenCalled(); expect(storage.read()).toBeNull();
  });
});
