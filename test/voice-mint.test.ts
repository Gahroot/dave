import { describe, expect, it, vi } from "vitest";
import { CLIENT_SECRETS_URL, mintRealtimeSecret } from "../src/voice/mint.ts";

const TOKEN = "eyJhbGciOi.PRIVATE_ACCESS_TOKEN_VALUE.sig";
const session = { type: "realtime", instructions: "hi", model: "ignored" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("mintRealtimeSecret", () => {
  it("posts the GA body with bearer auth and no model in the URL", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ value: "ek_test_secret", expires_at: 1_800_000_000 }));
    const r = await mintRealtimeSecret({ accessToken: TOKEN, model: "gpt-realtime-2.1", session, fetch });
    expect(r).toEqual({ ok: true, secret: "ek_test_secret", expiresAt: 1_800_000_000, model: "gpt-realtime-2.1" });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(CLIENT_SECRETS_URL);
    expect(String(url)).not.toContain("model");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toEqual({ authorization: `Bearer ${TOKEN}`, "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({ expires_after: { anchor: "created_at", seconds: 600 }, session: { type: "realtime", instructions: "hi", model: "gpt-realtime-2.1" } });
  });

  it("maps errors to fixed messages that never contain the token or provider text", async () => {
    const cases: [number, string][] = [[401, "reconnect"], [403, "not_entitled"], [429, "rate_limited"], [500, "mint_failed"], [400, "mint_failed"]];
    for (const [status, code] of cases) {
      const r = await mintRealtimeSecret({ accessToken: TOKEN, model: "gpt-realtime", session, fetch: async () => json({ error: { message: `bad ${TOKEN} PROVIDER_TEXT` } }, status) });
      expect(r).toMatchObject({ ok: false, code });
      expect(JSON.stringify(r)).not.toMatch(/PRIVATE_ACCESS|PROVIDER_TEXT/);
    }
    const thrown = await mintRealtimeSecret({ accessToken: TOKEN, model: "gpt-realtime", session, fetch: async () => { throw new Error(`net ${TOKEN}`); } });
    expect(thrown).toMatchObject({ ok: false, code: "mint_failed" });
    expect(JSON.stringify(thrown)).not.toContain("PRIVATE_ACCESS");
  });

  it("requires value and expires_at", async () => {
    for (const body of [{}, { value: 1, expires_at: 1 }, { value: "ek_x" }, { value: "ek_x", expires_at: "soon" }, "nope"]) {
      expect(await mintRealtimeSecret({ accessToken: TOKEN, model: "gpt-realtime", session, fetch: async () => json(body) })).toMatchObject({ ok: false, code: "mint_failed" });
    }
  });

  it("caps the response body at 64 KB", async () => {
    const big = JSON.stringify({ value: "ek_x", expires_at: 1, pad: "x".repeat(70 * 1024) });
    const r = await mintRealtimeSecret({ accessToken: TOKEN, model: "gpt-realtime", session, fetch: async () => new Response(big) });
    expect(r).toMatchObject({ ok: false, code: "mint_failed" });
  });

  it("honours the caller's abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch: typeof globalThis.fetch = async (_u, init) => { if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError"); return json({ value: "ek_x", expires_at: 1 }); };
    expect(await mintRealtimeSecret({ accessToken: TOKEN, model: "gpt-realtime", session, fetch, signal: controller.signal })).toMatchObject({ ok: false, code: "mint_failed" });
  });
});
