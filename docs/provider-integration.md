# Provider integration verification

Step 1 of the approved daily-use plan is **blocked on Claude isolation**, not complete.
Verified locally on 2026-09-08. No model calls, sign-in attempts, credential imports,
external project writes, or live database migrations were performed.

## OpenAI transport and storage

- Pinned `@prestyj/ai` 5.17.0; inspected its `src/index.ts`, `src/stream.ts` and the
  user's EZ Coder OpenAI OAuth implementation read-only. The OpenAI registry uses
  Codex transport when `accountId` is provided; omission selects API transport.
  Dave must require the account ID and must never silently fall back to API billing.
- OAuth reference uses PKCE S256, random state, client
  `app_EMoamEEZ73f0CkXaXp7hrann`, and redirect
  `http://localhost:1455/auth/callback`. Dave must improve callback validation,
  listener ownership, single-use handling and timeout/cancel behavior rather than
  copy the reference's raw-code paste fallback. Adapted helpers need MIT attribution.
- Pinned `@napi-rs/keyring` 2.0.0 after inspecting its native Rust implementation.
  On macOS it uses `apple_native_keyring_store::keychain::Store`, not the shell.
  Verified native write/read/replacement using a random disposable account under
  `com.dave.provider-storage-probe`; removed that exact entry in `finally`.
  No existing keychain entry was read or changed. This proves the native integration
  works here, not the as-yet-unimplemented Dave credential lifecycle.
- Installed dependencies with lifecycle scripts disabled. npm reported zero known
  dependency vulnerabilities; this is not a security certification.

## Claude: verified capabilities and blocking conflict

Installed executable: `/Users/groot/.local/bin/claude`, resolving to
`/Users/groot/.local/share/claude/versions/2.1.168`. `codesign --verify --strict`
passed. `--version`, `--help`, `auth login --help`, and `auth status --help` ran.
No authentication status/account data was read.

The installed CLI documents:

- `auth login --claudeai` for subscription login (not `--console`).
- `auth status --json` for status.
- `--tools ""`, `--strict-mcp-config`, `--mcp-config`, `--setting-sources`,
  `--settings`, `--disable-slash-commands`, `--no-session-persistence`, `--no-chrome`.
- `--bare` skips hooks/plugins but **does not read OAuth or keychain credentials**;
  it instead requires API-key authentication or an API-key helper.

The approved design requires both subscription authentication and no inherited
hooks/plugins. `--setting-sources ""` only excludes user/project/local settings;
managed settings have higher precedence. Current official settings reference
explicitly says `disableAllHooks: true` in non-managed settings does not disable
managed hooks or hooks from force-enabled managed plugins.

This is not only a documentation-version concern: read-only inspection of the
installed executable's bundled code confirms its all-hooks-off predicate checks
`policySettings.disableAllHooks`, and a non-policy `disableAllHooks` selects the
managed-hooks-only path. Its plugin startup path still loads managed plugins.
An empty working directory and tools/MCP flags do not eliminate that path.

Do not claim that the planned argv guarantees inference-only execution. Do not
change system-managed settings, patch the official executable, import subscription
tokens, use API billing, or silently weaken the no-hooks requirement. The current
implementation needs a product decision: keep Claude planning unavailable until
an isolation approach is verified, or pause for a revised integration design.
No conclusion is made that this user's account actually has managed hooks.

## Sources and comparison

- Local corpus: `zilliztech/memsearch`, commit
  `3ce8001786890f13a1b6839ef8156d3b194b6a74`,
  `plugins/_shared/scripts/maintenance-runner.py:413–457`.
  Reused as an architectural reference for bounded official-CLI inference.
  Its tools-disabled/MCP flags are not sufficient proof of hooks isolation.
- https://code.claude.com/docs/en/settings-reference.md (`disableAllHooks`)
- https://code.claude.com/docs/en/settings.md (settings precedence)
- https://code.claude.com/docs/en/cli-reference.md (`--setting-sources`, `--bare`)
- https://code.claude.com/docs/en/hooks.md (managed hooks)
- https://developers.openai.com/codex/auth.md
- Resolved source: `@napi-rs/keyring@2.0.0`, `src/entry.rs`.

Provider model IDs remain requested configuration, not proven account entitlement.
The user disputes the earlier provider-token restriction; this verification does
not resolve that disagreement. The selected transport remains the unmodified
Claude application, not a direct Anthropic subscription-token adapter.

## Progress boundary

The subsequent instruction authorizes step 2 while keeping Claude planning
fail-closed. Step 1's isolation verification remains unresolved; there is no
Claude planning implementation, API-billing substitute, or weakened isolation.

Step 2 removes EZ Coder task ingestion and projects legacy task data out of new
responses, including failed-refresh fallbacks. Metadata/workspace/session
identification and lightweight session recency remain. Manually edited text is
preserved; old task evidence is not exposed. Legacy inbox rows and snapshots are
not deleted or rewritten. Generated summaries use a bumped policy; out-of-scan
legacy generated text stays blank until a new scan can replace it.

`planningProjectFacts` is only a local, I/O-free allowlisted planning seed. It
cannot include tasks, imported attention, session text or manual summary notes.
The complete opt-in document collector, consent UI and AI planner are still
future steps; these tests do not claim a running end-to-end planner.

Boundary tests instrument attempted adapter reads and OS file opens with
synthetic denied-file sentinels. They cover cold discovery, fresh/cached refresh,
HTTP failed-refresh fallback, missing-source snapshots and the local planning
seed. Symlinked denied files are rejected before a file handle is opened.
Existing summary/editor work and live storage remain untouched by this rollout.
