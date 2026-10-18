# DAVE for iPhone and Android

A native Expo app with the same features as the DAVE web workbench. It talks to
the DAVE server on your Mac (the desktop app or `npm start`) over the opt-in,
end-to-end encrypted LAN gateway described in `../docs/mobile-pairing.md`.

## Pair and run

1. On the Mac, open DAVE → **Connections → Phone → Turn on phone access**. A QR
   code appears.
2. Build and start the app (a development build is required: the app uses the
   camera, the keychain and its own `dave://` link scheme):

   ```bash
   cd mobile
   npm install
   npx expo run:ios          # simulator or a cable-connected iPhone
   npx expo run:android      # emulator or a USB-connected phone
   ```

3. In the app tap **Scan pairing code** (or scan the QR with the iPhone Camera,
   which opens DAVE), confirm the Mac's name and address, and you are in. The
   phone and Mac must be on the same network.

One pairing admits one phone. **Pair a new phone** on the Mac rotates the key
and unpairs the old phone. **Forget this Mac** on the phone only clears the
phone.

Checks: `npm run typecheck` (strict TypeScript incl. the shared `../src`
modules) and `npm run bundle:check` (Metro bundles the iOS JavaScript, which
proves every import resolves and no server-only module reaches the phone).
Pure phone modules are also unit-tested from the root suite (`test/mobile-*.test.ts`);
the package is `"type": "module"` so the root `tsc` checks them as ES modules,
which is why Metro's config is `metro.config.cjs`. Imports of `src/lib/*`
from files the root tests reach use explicit `.ts` extensions.

**Talk to DAVE** needs OpenAI connected on the Mac (Connections). The phone
asks the Mac for a short-lived Realtime secret, then streams audio directly to
OpenAI over WebRTC (`react-native-webrtc`); the ChatGPT token never leaves the
Mac. Documents shared from the phone (PDF picker, photo library, camera) go to
the Mac as one sealed binary upload (25 MB max).

## How the code is organised

```
src/app/            expo-router routes (screens only; thin)
  _layout.tsx       providers + stack; everything but /pair needs a pairing
  (tabs)/           Focus · Inbox · Projects · Meetings · More
  focus/[project]   project focus (finish line, moves, tasks, plan)
  project/[id]      project workspace (Work / Reference)
  delivery/         delivery setup, coordination and review for a project
  agents/           Agent desk: runs, run workspace, new assignment, settings
  meetings/         meeting detail, reading instructions
  voice, cleanup    Talk to DAVE; Clean up (bulk clear / mark done with Undo)
  connections, issues, settings, pair
  (one flat root stack: every screen is registered in _layout.tsx inside
  Stack.Protected, so each gets the native back button)
src/features/<area>/  screen bodies and feature components, one folder per area
src/lib/            pairing storage, sealed transport (JSON + binary upload), API client,
                    useResource, data-events (reload screens when voice changes data)
src/ui/             theme tokens, primitives, status components, EvidenceList
../src/             shared with the server and web UI (pure TypeScript only)
```

### Rules for screen code

- **Data**: only `useApi()` (`api.get/post/put/patch/del`) and
  `useResource()` / `usePortfolio()` from `src/lib`. Same paths, methods and
  JSON bodies as the web UI's calls in `../src/ui/**`. Never call `fetch`.
  Writes default to a `{}` body because guarded routes require a JSON object.
- **Mutations are never retried automatically.** Disable the control while
  busy, show the server's error text (`describeError(e)`), keep drafts on
  failure, and on `409` reload the latest state before letting the user retry.
- **Reuse the web's pure logic** by relative import with the `.ts` extension,
  e.g. `../../../../src/ui/focus-model.ts`, `src/ui/inbox-model.ts`,
  `src/ui/meetings-model.ts`, `src/ui/delivery-review-model.ts`,
  `src/ui/coordination-handoff.ts`, `src/ui/delivery-handoff.ts`,
  `src/ui/top-action.ts`, `src/ui/format.ts`, `src/ui/status.ts`, and types
  from `src/shared/types.ts`, `src/intel/types.ts`, `src/agents/types.ts`,
  `src/meetings/types.ts`, `src/model/*.ts`. Never import `.tsx` components,
  Mantine, or the browser fetch helpers (`delivery-api.ts`, `intel-api.ts`);
  `import type` from them is fine. Anything that pulls in a `node:` module at
  runtime fails the bundle on purpose.
- **Status language**: every state is a spec from `../src/ui/status.ts`
  rendered with `StatusIcon` / `StatusMark` / `StatusTile` / `CountPill` /
  `TrustLadder` from `src/ui/status.tsx`. Amber your move, blue working, green
  done, red broken, gray parked, violet DAVE's guess. Tones color icons, tiles
  and rails, never body text.
- **Layout**: `Screen` (canvas + pull-to-refresh) → one `Panel` per section
  (never nested) → `Row`s. One `primary` `Button` per decision region;
  `danger`/`danger-subtle` for destructive actions behind `confirm()`.
  Tokens from `src/ui/theme.ts`; no ad-hoc colors.
- **Honesty boundaries** from `../DESIGN.md` hold on the phone: cached is not
  checked, agent-reported is not verified, passing checks is not acceptance,
  acceptance is not merge or deploy. Show the same consequence text next to
  the same actions as the web.
- **Accessibility**: 44 pt targets, `accessibilityLabel` on icon-only
  controls, `accessibilityRole="header"` on section titles (primitives do
  this), status never by color alone.
- Untrusted text (agent output, meeting transcripts, file contents) renders as
  plain selectable `Text` only.
