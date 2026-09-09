# Local provider and delivery request boundary

Step 4 installs a shared guard before route registration in `buildServer`.
It covers `/api/providers`, all descendants, `/api/projects/:id/delivery` and
its descendants, plus `/api/security/csrf`. Route matching uses Fastify's resolved
route definitions, including prefixed child plugins, not untrusted forwarded URLs.
No provider connection, model call or delivery endpoint implementation is added
by this step; tests use harmless fixture handlers under those namespaces.

## Request contract

- The Host must match an explicitly configured loopback origin, including its
  port. Production defaults are `http://127.0.0.1:4317` and
  `http://localhost:4317`, adjusted to the configured PORT. HTTP loopback origins
  only; no wildcard hosts, arbitrary IP spellings or external hostnames.
- Browser Origin must match that Host's exact configured origin. Forwarded host
  and protocol headers never expand trust. Duplicate authority/origin/token
  headers are rejected rather than accepting Node's first joined value.
- Same-origin browser GET/HEAD may omit Origin when `Sec-Fetch-Site` is
  `same-origin`. Writes require explicit matching Origin. Cross-site, same-site
  (but different origin), navigation and script-loading metadata are refused.
- Fetch `GET /api/security/csrf`, then send its token in `x-dave-csrf` on every
  POST/PUT/PATCH/DELETE. Tokens are random, per process and per configured origin,
  compared in constant time after validating fixed length. Keep them in memory;
  restart requires refetch. No cookie, provider credential or database entry is
  involved. Non-browser clients of these new APIs must explicitly send the
  configured Host/Origin and retrieve a token first.
- Writes require an uncompressed `application/json` object (optional UTF-8
  charset). Empty JSON, scalars, arrays, malformed JSON and prototype-poisoning
  objects fail before the handler. Operation-specific field schemas remain the
  responsibility of later provider/delivery routes.
- Each guarded route has a maximum 64 KiB body, enforced by Fastify's streaming
  parser even without Content-Length. Routes may lower but not raise this limit.
- Parser, validation and thrown handler errors are mapped to bounded generic
  responses, not raw exception text. Guard responses and token bootstrap are
  `no-store`, `nosniff`, and cross-origin-resource-policy `same-origin`. No CORS
  permission headers are added.

## Development and compatibility

The existing portfolio, notes, attention and health routes retain their current
client contract. This is not a claim that all legacy endpoints now have CSRF
protection. New credential/billable routes must stay inside the guarded namespaces
and use write methods for mutations; a GET must not start login, generation or
other changes. The separate future OAuth callback listener needs its own PKCE,
state and callback checks, not this browser CSRF token.

For Vite's existing Host-preserving development proxy, explicitly allow its exact
browser origin when starting a **fixture** server, for example:

```sh
PCC_HOME=/path/to/disposable/dave-fixture PCC_BROWSER_ORIGINS=http://localhost:5173 npm run server
```

Use the actual loopback browser origin; if Vite selects another port, configure
that port explicitly rather than widening the allowlist. Programmatic embedding
can supply `buildServer(paths, { browserOrigins: [...] })`. Invalid configuration
fails before the database is opened. Loopback binding remains `127.0.0.1`.

Do not restart live Dave for this change: the earlier v5 migration still requires
its separately planned rollout. This step left live servers, credentials, provider
billing and Claude's fail-closed boundary untouched.

## Evidence and limits

Focused command: `npx vitest run test/request-guard.test.ts`.

Tests cover hostile hosts/origins, forwarded-header non-trust, missing/invalid and
cross-origin/cross-process CSRF tokens, fetch metadata, unsupported media types,
malformed/oversized/multibyte bodies, non-object JSON, exception redaction, valid
same-origin requests, prefixed plugin inheritance, explicit dev origins, and
legacy client compatibility using isolated app storage. A real HTTP test sends a
chunked oversized body to an ephemeral loopback fixture listener, observing 413
before the handler runs. No live listener is used by that test.

This boundary defends against hostile browser origins, not code already executing
as the local user, same-origin XSS, browser extensions with access, or malicious
route code deliberately replacing framework controls. No provider sign-in or
browser UI walkthrough was performed in step 4.

Implementation evidence: searched `sec-fetch-site`, then read
`supermemoryai/supermemory` commit
`4d8a4ebfddadc3430f7f59a752cd374670833f50`,
`apps/sdk-playground/src/lib/request-validation.ts:26–120`. Reused the separation
of origin checks and bounded JSON handling; Dave is stricter about explicit
origins, missing write Origin, forwarded headers and port matching. Inspected
installed Fastify 5.12.1 `lib/route.js` for prefixed onRoute hooks and per-route
body limits, and `lib/content-type-parser.js` for streaming parser enforcement.
These references guide the implementation; the fixture tests establish runtime
behavior for this project.
