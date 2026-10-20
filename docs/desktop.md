# DAVE desktop app (macOS, Tauri)

A native macOS app that bundles its own Node runtime and the DAVE server, then
shows the web workbench in a native window. Nothing about the server changes:
the window loads `http://127.0.0.1:<port>/` from the bundled server, so the
loopback-only, same-origin and CSRF rules in `local-request-boundary.md` apply
exactly as in a browser. The server origin gets no Tauri IPC; only the bundled
loading/error page (`desktop/loading/index.html`) may call the two shell
commands (`status`, `retry`).

## Build and run

```bash
npm ci
npm run desktop:build   # stage, then `tauri build` → .app and .dmg
npm run desktop:dev     # stage, then `tauri dev` (debug shell, same bundled server)
npm run desktop:stage   # only stage Node + server (see below)
```

Artifacts:

- `src-tauri/target/release/bundle/macos/DAVE.app`
- `src-tauri/target/release/bundle/dmg/DAVE_<version>_<arch>.dmg`

Staging is explicit and reproducible:

- `scripts/desktop/stage-node.mjs` downloads the pinned official Node release
  (`NODE_VERSION`, currently v24.22.0), verifies its SHA-256 against that
  release's `SHASUMS256.txt`, and extracts only `bin/node` to
  `src-tauri/binaries/node-<target-triple>` (Tauri `externalBin`). It skips the
  download when the staged binary already matches. `--target
  aarch64-apple-darwin|x86_64-apple-darwin` selects the architecture.
- `scripts/desktop/stage-server.mjs` runs `npm run build`, copies `src/`,
  `dist/` and the package manifests into `src-tauri/resources/server/`, and
  installs production dependencies there (`npm ci --omit=dev`), including the
  native Keychain addon.

Both staging outputs and `src-tauri/target/` are gitignored.

If the DMG step fails with `hdiutil: couldn't unmount … Resource busy`, a
previous interrupted build left its scratch image mounted: run `hdiutil info`,
`hdiutil detach <device> -force` for any `rw.*DAVE*.dmg`, delete those files
under `bundle/macos/`, and build again. The `.app` is complete either way.

## What happens at launch

1. Port: 4317 if free, otherwise a free loopback port chosen by the OS. A
   browser can use the same server at that address while the app is open.
2. The shell starts `Contents/MacOS/node --experimental-strip-types
   Contents/Resources/server/src/server/index.ts` in its own process group,
   with `PORT`, `NODE_ENV=production` and a `PATH` taken from your login shell
   (`$SHELL -ilc`, with a timeout; fallback
   `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`) so Git and
   `ezcoder` resolve when the app is opened from Finder. `HOME`, `PCC_HOME`,
   `PCC_MOBILE_PORT` and `DAVE_AGENT_COMMAND` pass through unchanged.
3. Output goes to `~/Library/Logs/DAVE/server.log` (rotated to
   `server.log.1` past 5 MB).
4. When `GET /api/health` answers (30 s limit) the window navigates to the
   server. If the server exits or never becomes healthy, the loading page shows
   the reason, the last log lines, the log path and **Retry**. A server that
   dies later shows the same page with **Restart**.

Links to any other origin open in your default browser; only the server's own
loopback origin loads in the window. A second launch focuses the existing
window (single instance). **View → Reload** reloads the workbench.

Quitting (⌘Q, closing the last window, or SIGTERM to the app) hides the window
and sends SIGTERM to the server's process group. The server finishes requests
already in flight, then exits; idle quits take well under a second. Right after
launch the first portfolio scan can take several seconds (about 6 s measured
on a real portfolio), and a quit during it waits for the scan. After 8 s the
shell sends SIGKILL; SQLite keeps the database consistent if that happens.

## Voice and shared documents

**Talk to DAVE** works in the window. The pieces involved:

- `src-tauri/Info.plist` (merged into `DAVE.app/Contents/Info.plist` by Tauri)
  sets `NSMicrophoneUsageDescription`. This key is required, not cosmetic:
  without it WKWebView does not expose `navigator.mediaDevices` at all, and the
  voice page reports "Voice is not supported here" on **Start**. (Measured with
  a bare WKWebView probe on `http://127.0.0.1:<port>`: `isSecureContext` true
  either way, `mediaDevices` present only with the key.)
- Secure context: WebKit treats `http://127.0.0.1` and `http://localhost` as
  potentially trustworthy, so `getUserMedia` and `RTCPeerConnection` work over
  the plain-http loopback server. No https is needed.
- Permission policy (`permission_decision` in `src-tauri/src/lib.rs`, via
  Tauri's `on_permission_request`): microphone is granted only when the
  window's current top-level page is the server's own loopback origin
  (`http://127.0.0.1:<port>` or `http://localhost:<port>`); camera and every
  other kind, and any other origin, are denied. wry does not pass WebKit's
  requesting origin through, so the check uses the last committed page URL;
  only the loading page and the server origin can ever load in the window.
- What the user sees: no WebKit per-site prompt (the shell answers it). On the
  first **Start**, macOS shows its own one-time TCC prompt "“DAVE” would like
  to access the microphone" with the usage text above. If denied, re-enable it
  in System Settings → Privacy & Security → Microphone. The microphone is used
  only while a voice session runs.

Documents: the native Tauri file-drop handler is disabled on the main window
(`disable_drag_drop_handler()`, since the window is built in Rust rather than
from `tauri.conf.json`), so dropping a file on the voice panel reaches the
page's HTML5 drop handler. The file picker (`<input type=file>`) uses WebKit's
open panel; paste works as in a browser.

## Coexistence and data

The app uses the same storage as `npm start`: `~/.portfolio-command-center`
(or `PCC_HOME`). Only one DAVE runtime may use an app home at a time; a second
one stops with "Another DAVE runtime is using this app home". Quit the other
server first, or point one of them at a different `PCC_HOME`.

Phone access works the same as in the browser: **Connections → Phone** opens
the opt-in LAN listener (default port 4318, `PCC_MOBILE_PORT`). See
`mobile-pairing.md`.

## Signing and distribution

Local builds are unsigned. A copied or downloaded build is quarantined by
Gatekeeper; for your own machine: `xattr -dr com.apple.quarantine DAVE.app`.

To notarize for distribution:

- Sign with a Developer ID certificate (`APPLE_SIGNING_IDENTITY`), hardened
  runtime on (already set in `tauri.conf.json`).
- `src-tauri/Entitlements.plist` grants what Node needs under the hardened
  runtime: `com.apple.security.cs.allow-jit`,
  `allow-unsigned-executable-memory` and `disable-library-validation`, plus
  `com.apple.security.device.audio-input`, without which the hardened runtime
  blocks microphone capture. Local ad-hoc (linker-signed) builds carry no
  entitlements; they are applied only when signing with an identity.
- Sign nested code too: `Contents/MacOS/node` and every native addon under
  `Contents/Resources/server/node_modules/**/*.node` (for example
  `@napi-rs/keyring`), then notarize and staple the `.dmg`.
