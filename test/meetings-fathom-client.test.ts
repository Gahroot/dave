import { describe, expect, it } from 'vitest';
import {
  createFathomClient, FATHOM_API_BASE, retryAfterMs, transcriptBudget,
  type FathomRequestLog,
} from '../src/meetings/fathom-client.ts';

const KEY = 'fathom-test-key-0123456789abcdef';

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (url: URL) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push({ url: url.toString(), init: init ?? {} });
    return respond(url);
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Shaped like the example in Fathom's published OpenAPI document. */
const MEETING = {
  title: 'Acme weekly sync',
  meeting_title: 'Acme <> Dave weekly',
  recording_id: 123456789,
  url: 'https://fathom.video/calls/123456789',
  share_url: 'https://fathom.video/share/abc',
  created_at: '2026-09-28T17:01:30Z',
  scheduled_start_time: '2026-09-28T16:00:00Z',
  scheduled_end_time: '2026-09-28T17:00:00Z',
  recording_start_time: '2026-09-28T16:01:12Z',
  recording_end_time: '2026-09-28T17:00:55Z',
  calendar_invitees_domains_type: 'one_or_more_external',
  transcript_language: 'en',
  calendar_invitees: [
    { name: 'Dave Owner', email: 'dave@studio.dev', email_domain: 'studio.dev', is_external: false, matched_speaker_display_name: 'Dave Owner' },
    { name: 'Jane Client', email: 'Jane@Acme.com', email_domain: 'acme.com', is_external: true, matched_speaker_display_name: null },
  ],
  recorded_by: { name: 'Dave Owner', email: 'dave@studio.dev', email_domain: 'studio.dev', team: null },
};

describe('Fathom client', () => {
  it('lists my meetings with the fixed URL, key header and no redirects', async () => {
    const { fetch, calls } = fakeFetch(() => json({ limit: 10, next_cursor: 'eyJwIjoyfQ==', items: [MEETING] }));
    const client = createFathomClient({ apiKey: () => KEY, fetch });
    const result = await client.listMeetings({ createdAfter: '2026-09-01T00:00:00Z', recordedBy: 'Dave@Studio.dev', cursor: 'abc' });
    expect(result.ok).toBe(true);
    const url = new URL(calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${FATHOM_API_BASE}/meetings`);
    expect(url.searchParams.get('created_after')).toBe('2026-09-01T00:00:00.000Z');
    expect(url.searchParams.getAll('recorded_by[]')).toEqual(['dave@studio.dev']);
    expect(url.searchParams.get('cursor')).toBe('abc');
    expect(url.searchParams.has('include_transcript')).toBe(false);
    expect(url.searchParams.has('include_summary')).toBe(false);
    expect(url.searchParams.has('include_action_items')).toBe(false);
    expect(calls[0]!.init.redirect).toBe('error');
    expect((calls[0]!.init.headers as Record<string, string>)['X-Api-Key']).toBe(KEY);
    if (!result.ok) return;
    expect(result.value.nextCursor).toBe('eyJwIjoyfQ==');
    expect(result.value.meetings).toEqual([{
      recordingId: '123456789',
      title: 'Acme weekly sync',
      calendarTitle: 'Acme <> Dave weekly',
      url: 'https://fathom.video/calls/123456789',
      shareUrl: 'https://fathom.video/share/abc',
      createdAt: '2026-09-28T17:01:30.000Z',
      startedAt: '2026-09-28T16:01:12.000Z',
      endedAt: '2026-09-28T17:00:55.000Z',
      recordedBy: 'dave@studio.dev',
      external: true,
      attendees: [
        { name: 'Dave Owner', email: 'dave@studio.dev', domain: 'studio.dev', external: false, speakerName: 'Dave Owner' },
        { name: 'Jane Client', email: 'jane@acme.com', domain: 'acme.com', external: true, speakerName: null },
      ],
    }]);
  });

  it('skips malformed meetings and never keeps a non-Fathom or non-https link', async () => {
    const items = [
      { ...MEETING, recording_id: 'not-a-number' },
      { ...MEETING, recording_id: 5, created_at: 'yesterday' },
      { ...MEETING, recording_id: 6, url: 'javascript:alert(1)', share_url: 'https://evil.example/fathom.video' },
      { ...MEETING, recording_id: 7, url: 'http://fathom.video/calls/7' },
      'garbage',
    ];
    const { fetch } = fakeFetch(() => json({ limit: null, next_cursor: null, items }));
    const client = createFathomClient({ apiKey: () => KEY, fetch });
    const result = await client.listMeetings({ createdAfter: '2026-09-01T00:00:00Z', recordedBy: 'dave@studio.dev', cursor: null });
    expect(result.ok && result.value.meetings.map(m => [m.recordingId, m.url, m.shareUrl])).toEqual([
      ['6', null, null],
      ['7', null, 'https://fathom.video/share/abc'],
    ]);
    expect(result.ok && result.value.invalid).toBe(3);
    expect(result.ok && result.value.nextCursor).toBeNull();
  });

  it('refuses invalid queries without calling Fathom', async () => {
    const { fetch, calls } = fakeFetch(() => json({ items: [] }));
    const client = createFathomClient({ apiKey: () => KEY, fetch });
    expect(await client.listMeetings({ createdAfter: 'soon', recordedBy: 'dave@studio.dev', cursor: null })).toEqual({ ok: false, error: { kind: 'bad_request' } });
    expect(await client.listMeetings({ createdAfter: '2026-09-01T00:00:00Z', recordedBy: 'not an email', cursor: null })).toEqual({ ok: false, error: { kind: 'bad_request' } });
    expect(await client.listMeetings({ createdAfter: '2026-09-01T00:00:00Z', recordedBy: 'dave@studio.dev', cursor: 'has space' })).toEqual({ ok: false, error: { kind: 'bad_request' } });
    for (const id of ['12a', '../meetings', '', '1'.repeat(21), '1/2']) {
      expect(await client.getTranscript(id)).toEqual({ ok: false, error: { kind: 'bad_request' } });
    }
    expect(calls).toHaveLength(0);
  });

  it('reads a transcript and drops malformed entries', async () => {
    const { fetch, calls } = fakeFetch(() => json({ transcript: [
      { speaker: { display_name: 'Jane Client', matched_calendar_invitee_email: 'jane@acme.com' }, text: 'The export keeps timing out.', timestamp: '00:05:32' },
      { speaker: { display_name: 'Dave Owner', matched_calendar_invitee_email: null }, text: "I'll send the API docs by Friday.", timestamp: '00:05:40' },
      { speaker: { display_name: 'Bad' }, text: 'no timestamp' },
      { speaker: { display_name: 'Bad' }, text: 'bad timestamp', timestamp: '5:40' },
      { text: 'no speaker', timestamp: '00:06:00' },
    ] }));
    const client = createFathomClient({ apiKey: () => KEY, fetch });
    const result = await client.getTranscript('123456789');
    expect(new URL(calls[0]!.url).pathname).toBe('/external/v1/recordings/123456789/transcript');
    expect(result).toEqual({ ok: true, value: { invalid: 3, entries: [
      { speaker: 'Jane Client', email: 'jane@acme.com', timestamp: '00:05:32', text: 'The export keeps timing out.' },
      { speaker: 'Dave Owner', email: null, timestamp: '00:05:40', text: "I'll send the API docs by Friday." },
    ] } });
  });

  it.each([
    [401, { kind: 'invalid_key' }],
    [403, { kind: 'invalid_key' }],
    [404, { kind: 'not_found' }],
    [500, { kind: 'http', status: 500 }],
  ])('maps status %i', async (status, error) => {
    const { fetch } = fakeFetch(() => json({ message: `secret ${KEY}` }, status));
    const client = createFathomClient({ apiKey: () => KEY, fetch });
    const result = await client.getTranscript('1');
    expect(result).toEqual({ ok: false, error });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('honours Retry-After on 429', async () => {
    const now = Date.parse('2026-09-30T12:00:00Z');
    const { fetch } = fakeFetch(() => json({}, 429, { 'retry-after': '30' }));
    const client = createFathomClient({ apiKey: () => KEY, fetch, now: () => now });
    expect(await client.listMeetings({ createdAfter: '2026-09-01T00:00:00Z', recordedBy: 'dave@studio.dev', cursor: null }))
      .toEqual({ ok: false, error: { kind: 'rate_limited', retryAfterMs: 30_000 } });
    expect(retryAfterMs(null, now)).toBe(60_000);
    expect(retryAfterMs('Wed, 30 Sep 2026 12:02:00 GMT', now)).toBe(120_000);
    expect(retryAfterMs('999999', now)).toBe(3_600_000);
    expect(retryAfterMs('0', now)).toBe(1000);
    expect(retryAfterMs('soon', now)).toBe(60_000);
  });

  it('makes no call without a key, and survives a failing key store', async () => {
    const { fetch, calls } = fakeFetch(() => json({ items: [] }));
    expect(await createFathomClient({ apiKey: () => null, fetch }).checkKey()).toEqual({ ok: false, error: { kind: 'no_key' } });
    expect(await createFathomClient({ apiKey: () => { throw new Error('locked'); }, fetch }).checkKey()).toEqual({ ok: false, error: { kind: 'no_key' } });
    expect(calls).toHaveLength(0);
  });

  it('checks the key with a light listing that returns no meetings', async () => {
    const now = Date.parse('2026-09-30T12:00:00Z');
    const { fetch, calls } = fakeFetch(() => json({ limit: null, next_cursor: null, items: [] }));
    expect(await createFathomClient({ apiKey: () => KEY, fetch, now: () => now }).checkKey()).toEqual({ ok: true, value: true });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/external/v1/meetings');
    expect([...url.searchParams.keys()]).toEqual(['created_after']);
    expect(url.searchParams.get('created_after')).toBe('2026-09-30T12:00:00.000Z');
  });

  it('caps responses at the byte limit, by header and while streaming', async () => {
    const big = JSON.stringify({ transcript: [{ speaker: { display_name: 'A' }, text: 'x'.repeat(200), timestamp: '00:00:01' }] });
    const declared = fakeFetch(() => new Response(big, { status: 200, headers: { 'content-length': String(10_000_000) } }));
    expect(await createFathomClient({ apiKey: () => KEY, fetch: declared.fetch, maxBytes: 100 }).getTranscript('1'))
      .toEqual({ ok: false, error: { kind: 'too_large' } });
    const streamed = fakeFetch(() => new Response(new ReadableStream({
      start(controller) { for (let i = 0; i < 10; i++) controller.enqueue(new TextEncoder().encode('x'.repeat(50))); controller.close(); },
    }), { status: 200 }));
    expect(await createFathomClient({ apiKey: () => KEY, fetch: streamed.fetch, maxBytes: 100 }).getTranscript('1'))
      .toEqual({ ok: false, error: { kind: 'too_large' } });
  });

  it('times out a hanging request and reports cancellation separately', async () => {
    const hanging = ((_: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })) as typeof fetch;
    expect(await createFathomClient({ apiKey: () => KEY, fetch: hanging, timeoutMs: 20 }).getTranscript('1'))
      .toEqual({ ok: false, error: { kind: 'timeout' } });
    const controller = new AbortController();
    const pending = createFathomClient({ apiKey: () => KEY, fetch: hanging, timeoutMs: 5000 }).getTranscript('1', controller.signal);
    controller.abort();
    expect(await pending).toEqual({ ok: false, error: { kind: 'cancelled' } });
  });

  it('rejects non-JSON and wrongly shaped bodies', async () => {
    const text = fakeFetch(() => new Response('<html>', { status: 200 }));
    expect(await createFathomClient({ apiKey: () => KEY, fetch: text.fetch }).getTranscript('1')).toEqual({ ok: false, error: { kind: 'bad_response' } });
    const shape = fakeFetch(() => json({ transcript: 'nope' }));
    expect(await createFathomClient({ apiKey: () => KEY, fetch: shape.fetch }).getTranscript('1')).toEqual({ ok: false, error: { kind: 'bad_response' } });
  });

  it('keeps transcript fetches to four a minute', async () => {
    let now = 0;
    const { fetch, calls } = fakeFetch(() => json({ transcript: [] }));
    const client = createFathomClient({ apiKey: () => KEY, fetch, now: () => now, budget: transcriptBudget(4) });
    for (let i = 0; i < 4; i++) expect((await client.getTranscript(String(i + 1))).ok).toBe(true);
    now = 20_000;
    expect(await client.getTranscript('9')).toEqual({ ok: false, error: { kind: 'budget', retryAfterMs: 40_000 } });
    expect(calls).toHaveLength(4);
    now = 60_000;
    expect((await client.getTranscript('9')).ok).toBe(true);
  });

  it('reports each call to the observer without the key or body', async () => {
    const log: FathomRequestLog[] = [];
    let now = 1000;
    const { fetch } = fakeFetch(() => { now += 25; return json({ transcript: [] }); });
    await createFathomClient({ apiKey: () => KEY, fetch, now: () => now, onRequest: e => log.push(e) }).getTranscript('1');
    expect(log).toEqual([{ endpoint: 'transcript', status: 200, outcome: 'ok', elapsedMs: 25, bytes: '{"transcript":[]}'.length }]);
    expect(JSON.stringify(log)).not.toContain(KEY);
  });
});
