import {
  MAX_UPLOAD_BYTES, openUpload, sealUpload,
  fromBase64Url, isAllowedRpcPath, newDeviceId, newRequestId, openJson, openRequest, openResponse, pairingLink,
  parsePairingLink, randomRootKey, requestIsFresh, roomId, sealJson, sealRequest, sealResponse, toBase64Url, toHex,
  utf8Decode, utf8Encode, type RpcRequest,
} from "../src/mobile/protocol.ts";

const fixedKey = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const device = `phone-${"a".repeat(32)}`;
const request = (overrides: Partial<RpcRequest> = {}): RpcRequest => ({
  v: 1, t: "req", id: "0".repeat(32), at: 1_000_000, device, method: "POST", path: "/api/refresh", body: { ok: true }, ...overrides,
} as RpcRequest);

describe("mobile protocol", () => {
  it("round-trips a sealed request and response between phone and Mac", () => {
    const sealed = sealRequest(fixedKey, request());
    expect(openRequest(fixedKey, sealed)).toEqual(request());
    const response = { v: 1 as const, t: "res" as const, id: "0".repeat(32), at: 5, status: 200, body: { hello: "wörld 🌍" } };
    expect(openResponse(fixedKey, response.id, sealResponse(fixedKey, response))).toEqual(response);
  });

  it("refuses a frame under another key, another request id or the wrong direction", () => {
    const other = Uint8Array.from({ length: 32 }, () => 9);
    expect(openRequest(other, sealRequest(fixedKey, request()))).toBeUndefined();
    const response = { v: 1 as const, t: "res" as const, id: "0".repeat(32), at: 5, status: 200, body: null };
    expect(openResponse(fixedKey, "1".repeat(32), sealResponse(fixedKey, response))).toBeUndefined();
    // A response can never be reflected back at the Mac as a request.
    expect(openRequest(fixedKey, sealResponse(fixedKey, response))).toBeUndefined();
  });

  it("detects any tampering with the ciphertext", () => {
    const sealed = sealRequest(fixedKey, request());
    const bytes = fromBase64Url(sealed.ct);
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    expect(openRequest(fixedKey, { ...sealed, ct: toBase64Url(bytes) })).toBeUndefined();
    expect(openRequest(fixedKey, { ...sealed, v: 2 })).toBeUndefined();
  });

  it("rejects unknown fields, bad ids, bodies on GET and oversized bodies", () => {
    const open = (value: Record<string, unknown>) => openRequest(fixedKey, sealRequest(fixedKey, value as RpcRequest));
    expect(open({ ...request(), extra: 1 })).toBeUndefined();
    expect(open({ ...request(), id: "short" })).toBeUndefined();
    expect(open({ ...request(), device: "phone" })).toBeUndefined();
    expect(open({ ...request(), method: "GET" })).toBeUndefined();
    expect(open({ ...request(), method: "TRACE" })).toBeUndefined();
    expect(open({ ...request(), body: { text: "x".repeat(70_000) } })).toBeUndefined();
    expect(open({ v: 1, t: "hello", id: "0".repeat(32), at: 1, device })).toEqual({ v: 1, t: "hello", id: "0".repeat(32), at: 1, device });
  });

  it("allows only the app's own API, never pairing management or the CSRF bootstrap", () => {
    expect(isAllowedRpcPath("/api/portfolio")).toBe(true);
    expect(isAllowedRpcPath("/api/agents/runs/abc?after=3")).toBe(true);
    for (const path of ["/api/mobile/pairing", "/api/mobile", "/api/security/csrf", "/index.html", "/api/../api/mobile/pairing",
      "/api/x/%2e%2e/mobile", "/api//mobile", "/api/x#frag", "/api/x\\y", "/api/\u0000", `/api/${"x".repeat(3000)}`,
      // Percent-encoded forms the server decodes back to a denied route.
      "/api/%6dobile/pairing/rotate", "/api/%6Dobile/pairing", "/api/mobil%65", "/api/%73ecurity/csrf", "/api%2fmobile/pairing",
      "/api/MOBILE/pairing", "/api/%256dobile/pairing", "/api/x/%2E/..", "/api/x/%00", "/api/x/%E0%A4%A", "/api/x%3F/mobile"]) {
      expect(isAllowedRpcPath(path), path).toBe(false);
    }
    expect(isAllowedRpcPath("/api/projects/abc?q=50%25%20off")).toBe(true);
    expect(isAllowedRpcPath("/api/projects/caf%C3%A9")).toBe(true);
  });

  it("encodes the key only in the link fragment and validates it on scan", () => {
    const key = toHex(fixedKey);
    const link = pairingLink({ hosts: ["192.168.1.20", "mac.local"], port: 4318, room: roomId(fixedKey), name: "Dave's MacBook", key });
    const [beforeFragment = ""] = link.split("#");
    expect(beforeFragment).not.toContain(toBase64Url(fixedKey));
    expect(beforeFragment).not.toContain(key);
    expect(parsePairingLink(link)).toEqual({ ok: true, offer: { hosts: ["192.168.1.20", "mac.local"], port: 4318, room: roomId(fixedKey), name: "Dave's MacBook", key } });
  });

  it("explains unusable pairing links", () => {
    const good = pairingLink({ hosts: ["10.0.0.2"], port: 4318, room: roomId(fixedKey), name: "Mac", key: toHex(fixedKey) });
    expect(parsePairingLink("https://example.com").ok).toBe(false);
    expect(parsePairingLink(good.split("#")[0] ?? "").ok).toBe(false);
    expect(parsePairingLink(good.replace(roomId(fixedKey), "f".repeat(48))).ok).toBe(false);
    expect(parsePairingLink(good.replace("h=10.0.0.2", "h=evil host")).ok).toBe(false);
    expect(parsePairingLink(good.replace("p=4318", "p=0")).ok).toBe(false);
    expect(parsePairingLink(good.replace("v=1", "v=2")).ok).toBe(false);
  });

  it("bounds request freshness by skew and by server start", () => {
    expect(requestIsFresh(1_000_000, 1_000_000 + 119_000)).toBe(true);
    expect(requestIsFresh(1_000_000, 1_000_000 + 121_000)).toBe(false);
    expect(requestIsFresh(1_000_000, 1_050_000, 1_020_000)).toBe(false);
  });

  it("mints well-formed ids and keys, and encodes text exactly", () => {
    expect(newRequestId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newDeviceId()).toMatch(/^phone-[0-9a-f]{32}$/);
    expect(randomRootKey()).toHaveLength(32);
    for (const text of ["", "plain", "é", "€", "🌍 emoji", "\u{10ffff}"]) {
      expect(utf8Decode(utf8Encode(text))).toBe(text);
      expect(Array.from(utf8Encode(text))).toEqual(Array.from(new TextEncoder().encode(text)));
    }
    expect(() => utf8Decode(Uint8Array.from([0xc0, 0x80]))).toThrow();
    expect(() => utf8Decode(Uint8Array.from([0xe2, 0x82]))).toThrow();
    for (const length of [0, 1, 2, 3, 31, 32, 33]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37) & 255);
      expect(toBase64Url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
      expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes));
    }
    expect(openJson(fixedKey, "a", sealJson(fixedKey, "b", 1))).toBeUndefined();
  });
});

describe("mobile protocol: documents", () => {
  const header = { v: 1 as const, t: "upload" as const, id: "a".repeat(32), at: 5, device, name: "Brief — v2.pdf", project: "proj-1" };

  it("round-trips an upload frame without base64, and binds it to the pairing", () => {
    const file = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 31) & 255);
    const wire = sealUpload(fixedKey, header, file);
    expect(wire.length).toBe(24 + 4 + new TextEncoder().encode(JSON.stringify(header)).length + file.length + 16);
    const opened = openUpload(fixedKey, wire);
    expect(opened?.header).toEqual(header);
    expect(Array.from(opened?.file ?? [])).toEqual(Array.from(file));
    expect(openUpload(Uint8Array.from({ length: 32 }, () => 7), wire)).toBeUndefined();
  });

  it("refuses tampered, empty, oversized or malformed uploads", () => {
    const wire = sealUpload(fixedKey, header, Uint8Array.of(1, 2, 3));
    const flipped = wire.slice();
    flipped[40] = (flipped[40] ?? 0) ^ 1;
    expect(openUpload(fixedKey, flipped)).toBeUndefined();
    expect(openUpload(fixedKey, new Uint8Array(10))).toBeUndefined();
    expect(openUpload(fixedKey, sealUpload(fixedKey, header, new Uint8Array(0)))).toBeUndefined();
    expect(() => sealUpload(fixedKey, header, new Uint8Array(MAX_UPLOAD_BYTES + 1))).toThrow();
    for (const bad of [{ ...header, name: "" }, { ...header, name: "a\u0000b" }, { ...header, project: "../x" }, { ...header, t: "req" }, { ...header, extra: 1 }]) {
      expect(openUpload(fixedKey, sealUpload(fixedKey, bad as typeof header, Uint8Array.of(1))), JSON.stringify(bad)).toBeUndefined();
    }
    expect(openUpload(fixedKey, sealUpload(fixedKey, { ...header, project: null }, Uint8Array.of(1)))?.header.project).toBeNull();
  });

  it("carries binary responses as base64url with a validated media type", () => {
    const id = "b".repeat(32);
    const binary = { v: 1 as const, t: "res" as const, id, at: 1, status: 200, body: toBase64Url(Uint8Array.of(137, 80, 78, 71)), encoding: "base64url" as const, contentType: "image/png" };
    expect(openResponse(fixedKey, id, sealResponse(fixedKey, binary))).toEqual(binary);
    expect(openResponse(fixedKey, id, sealResponse(fixedKey, { ...binary, contentType: "image/png; x=<script>" }))).toBeUndefined();
    expect(openResponse(fixedKey, id, sealResponse(fixedKey, { ...binary, body: "not base64!" }))).toBeUndefined();
  });
});
