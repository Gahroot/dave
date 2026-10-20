# Phone pairing and the LAN gateway

DAVE's phone app talks to the same server as the web UI. The server stays
loopback-only by default; phone access is a third explicit opt-in exception
(after Agent desk and Meetings). When the operator switches it on in
**Connections → Phone**, the server opens a second, separate listener on the
local network that accepts only sealed requests from the one phone that claimed
the pairing.

Design follows pew2's pairing model (studied in the local `~/pew2` checkout;
no code copied — pew2 is AGPL-3.0):

- One 32-byte **root key** per pairing (CSPRNG). It reaches the phone only in
  the QR link's **fragment** and is stored on the Mac in the Keychain
  (`com.dave.mobile.pairing`), on the phone in the Secure Enclave–backed
  keychain (`expo-secure-store`).
- A **room id** = HKDF-SHA256(root, `dave/mobile/room/v1`, 24 bytes) names the
  pairing on the wire (`x-dave-room` header). Not a secret; a cheap
  pre-decryption filter.
- **Per-direction keys** (HKDF, `dave/mobile/phone-to-mac/v1`,
  `dave/mobile/mac-to-phone/v1`) seal every request and response with
  XChaCha20-Poly1305. Associated data binds a request to its room and a
  response to its request id, so frames cannot be reflected or swapped.
- **One pairing, one phone** (trust on first use): the first device id to
  complete a valid `hello` is recorded as `claimedBy`; any other device holding
  a copy of the QR is refused. **Pair a new phone** rotates the key, which
  unpairs the old phone. Rotation is the only revocation.
- **Replay**: every request carries a random 128-bit id and a millisecond
  timestamp. The Mac rejects timestamps more than 2 minutes from its clock,
  timestamps from before the server process started, and any id it has seen in
  the window.

The wire format lives in one pure module shared by both ends:
`src/mobile/protocol.ts` (tests: `test/mobile-protocol.test.ts`).

## Pairing link (QR content)

```
dave://pair?v=1&h=<host>[,<host>…]&p=<port>&r=<room id>&n=<display name>#k=<base64url root key>
```

`h` lists up to six LAN IPv4 addresses / hostnames, best first; the phone tries
each with `hello`. `r` must equal `roomId(k)`; `parsePairingLink` checks this.
The `dave://` scheme lets the iPhone Camera app open the DAVE app directly; the
app still shows a confirmation step before pairing.

## LAN gateway (`src/mobile/gateway.ts`)

- Separate Fastify instance bound to `0.0.0.0:${PCC_MOBILE_PORT ?? 4318}`,
  started only when phone access is enabled, and only from the server entry
  point or an explicit test (never as a side effect of `buildServer` in tests).
- Exactly two routes: `POST /v1/rpc`, body = sealed `Envelope` JSON
  (`{ v: 1, n, ct }`), header `x-dave-room`, body limit 128 KiB; and
  `POST /v1/upload` (see *Document upload*). No CORS, no static files;
  everything else is a bare 404.
- The `x-dave-room` check (and the rate-limit check) runs in an `onRequest`
  hook, before any body is read: a stranger cannot make the Mac buffer a
  25 MiB frame. A wrong room is a counted failure.
- Wrong room, malformed or undecryptable frame, replayed id → plaintext
  `404 {"error":"not found"}` (no oracle). Repeated failures from one address
  → `429` (more than 30 failures in a sliding 60 s window; at most 1024
  addresses tracked). A full replay cache (10 000 live ids) also answers a
  plaintext `429`.
- The `enabled` switch is the non-secret `mobile_settings` row in app SQLite,
  created idempotently on first use (no schema version bump).
- After decryption, everything is answered with a sealed `RpcResponse`
  (HTTP 200 on the wire; the real status is inside):
  - stale clock → status `401`, body `{ error: "clock", message }`;
  - device not the claimed phone → `403`, `{ error: "device-refused", message }`;
  - `hello` → `200`, `HelloBody` `{ server: "dave", protocol: 1, name }` and
    claims the pairing if unclaimed;
  - `req` → dispatched with `app.inject()` into the loopback app as a
    same-origin client: `host`/`origin` set to the first configured loopback
    origin, `sec-fetch-site: same-origin`, `content-type: application/json`
    and a CSRF token the gateway fetched from `/api/security/csrf` itself. The
    existing request guard therefore runs unchanged. The response's status and
    parsed JSON (or text) body are sealed back.
  - binary answers (any content type that is not JSON and not `text/*`, e.g.
    `GET /api/files/:id/content` → `image/png`, `application/pdf`) are sealed
    as `{ status, body: <base64url bytes>, encoding: "base64url",
    contentType: <media type, no parameters> }`. Above
    `MAX_BINARY_RESPONSE_BYTES` (25 MiB) the answer is a sealed
    `502 { error: "too-large", message }`.

### Document upload (`POST /v1/upload`)

- Header `x-dave-room`, `content-type: application/octet-stream` (the only
  type parsed on this route), body limit `MAX_SEALED_UPLOAD_BYTES`
  (file ≤ `MAX_UPLOAD_BYTES` = 25 MiB, header JSON ≤ 4 KiB).
- Wire = `nonce(24) || XChaCha20-Poly1305(phone→Mac key, AD = "dave/v1|upload|<room>")`
  over `u32be(headerLength) || header JSON || file bytes`; header =
  `UploadHeader { v: 1, t: "upload", id, at, device, name, project }`
  (`sealUpload` / `openUpload` in `src/mobile/protocol.ts`). No base64: the
  file is sealed once, as bytes.
- Same pipeline as `/v1/rpc` (shared code): any open failure or replayed id →
  plaintext 404; clock → sealed 401; another device → sealed 403; claim on
  first use. Then dispatched as `POST /api/files` with the file as payload,
  `x-dave-filename: encodeURIComponent(name)`, `x-dave-project` when set, and
  the same same-origin + CSRF framing. The JSON answer
  (`{ document, duplicate }`, 201 or 200) is sealed back as an `RpcResponse`.
  Uploads are never retried by the phone.

### Voice through the tunnel

Only the control plane crosses the gateway: `GET /api/voice/status`,
`POST /api/voice/sessions` (the Mac mints a short-lived Realtime client
secret with the ChatGPT credentials it holds), `…/tools`, `…/approval`,
`…/confirm`, `…/end`. Audio flows phone ↔ OpenAI directly using that
ephemeral secret; the ChatGPT access token never leaves the Mac. (Starting a
session through `app.inject()` is not aborted early: light-my-request does
not emit `close` on its fake request unless asked to, which a test covers.)
- Allowed paths: `isAllowedRpcPath` — `/api/*` except `/api/mobile/*` and
  `/api/security/*`. The phone can never read, rotate or widen its pairing.

## Pairing management API (loopback web UI only)

Guarded namespace `/api/mobile` (added to the request guard's list; CSRF and
same-origin rules apply). Unreachable through the gateway.

| Route | Effect | Response |
| --- | --- | --- |
| `GET /api/mobile/pairing` | Status | `MobilePairingStatus` |
| `POST /api/mobile/pairing/enable` `{}` | Mint a pairing if none, start the LAN listener, persist `enabled` | `MobilePairingStatus` |
| `POST /api/mobile/pairing/disable` `{}` | Stop the listener, keep the pairing | `MobilePairingStatus` |
| `POST /api/mobile/pairing/rotate` `{}` | New key, clears the claim (unpairs the phone) | `MobilePairingStatus` |
| `POST /api/mobile/pairing/forget` `{}` | Delete the pairing, stop the listener | `MobilePairingStatus` |

```ts
type MobilePairingStatus = {
  enabled: boolean;            // operator switched phone access on
  listening: boolean;          // LAN listener is bound right now
  port: number;
  hosts: string[];             // advertised LAN addresses, best first
  name: string;                // Mac display name shown on the phone
  paired: boolean;             // a phone has claimed this pairing
  device: string | null;       // claimed device id, shortened for display
  claimedAt: string | null;
  createdAt: string | null;
  link: string | null;         // dave://pair… — only when enabled, listening and unclaimed
  qrSvg: string | null;        // SVG markup for `link`, same condition
  error: string | null;        // e.g. Keychain unavailable, port in use
};
```

The web UI shows the QR in **Connections → Phone** while unclaimed; once a
phone has claimed it the link is no longer returned (it would be refused
anyway) and the panel offers **Pair a new phone** (rotate) and **Turn off**.

## Threat model and limits

Defends against other devices on the LAN, a leaked QR after the phone has
claimed it, eavesdroppers and tampering on the Wi-Fi. Does **not** defend
against someone who scans the QR before your phone does (rotate if a code
leaked before use), code already running as your user on the Mac, or a lost
unlocked phone (rotate). No forward secrecy: one key for the life of a
pairing. Plain HTTP on the LAN carries only sealed frames; iOS needs
`NSAllowsLocalNetworking` and Android cleartext permission for that reason.
