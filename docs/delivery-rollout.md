# Delivery implementation checkpoint — 8 September 2026

## Implemented

Steps 2–11 are implemented: task-free snapshots/context, additive v5 delivery
storage, local request boundary, Dave-owned OpenAI OAuth/Keychain or explicit
session mode, bounded context consent/planning, guarded APIs, whole-milestone
handoff and native milestone/Connections UI. Step 6 uses the user's authorized
fail-closed Claude exception; subscription-compatible hook isolation is still
unresolved, with no CLI inference or API-billing fallback.

Step 12 automated verification completed: 277 tests across 28 files, standalone
typecheck, separate production build, existing notes/attention walkthrough and new
delivery walkthrough. The new browser run verified approval, whole-capability
planning with fake inference, exact clipboard text/fallback, lost-response retry
without double completion, focus/next/reload/block/reopen, light/dark, reduced
motion, forced colors, 320px and 200% root text. Parent inspected captures and
reduced narrow shared gutters, rebuilt, then reran the delivery browser flow.

Test changes are intentional: new suites cover requested functionality; older
synthetic attention uses retained EZBoss input rather than forbidden EZ Coder
tasks, and old Home-note navigation/copy assertions now target project details.
Editing/error recovery/polling/focus/clipboard coverage was retained. No test was
skipped or disabled to get a passing result.

Private runtime evidence remains ignored under `.ezcoder/screenshots/step12`.
`DESIGN.md` records limited contrast measurements and remaining accessibility
coverage. No screen-reader, comprehensive WCAG/ADA, true browser-zoom, field
performance, real provider/model entitlement or real qualitative plan claim is
made. These remain unverified rather than inferred from passing automation.

## Human-assisted next stage

Step 13 requires the user's OpenAI sign-in and exact project-context approval.
An isolated real-provider preview is running at `http://127.0.0.1:4321`, process
31936 (EZ Coder task `22b32d49`), using `/tmp/dave-preview.uaUvxq` as its appHome.
It is **not** the live Dave database. Initial health/provider status reads passed:
OpenAI disconnected, Claude unavailable. No login, credential restoration or model
call was started by the agent. This preview can discover projects read-only but
has independent notes/delivery state; do not mistake blank preview notes for loss
of saved live notes. Keep this preview directory until any new user-entered work
has been deliberately retained during rollout.

In Connections, the user must choose storage and sign in (or explicitly restore
Dave-owned saved credentials), then select a project and review/approve its exact
context. Only then can one controlled model generation establish account/model
availability and actual milestone quality. No automatic provider switching or
billing substitution is permitted. The assistant must inspect the generated
milestone and handoff, not treat a successful HTTP response as qualitative proof.

## Live rollout remains pending

Step 14 was not performed. Existing live listeners/storage on 4317/4319 were not
stopped, restarted or migrated. No credentials were imported from EZ Coder. Do not
restart those servers casually: current code automatically upgrades to v5.

Before live application: inventory identified writers; take and time a fresh
restorable backup; quiesce only Dave writers; preserve prior summaries, pins,
attention outcomes and no-live-client constraints; retain any new preview state
with explicit project-identity mapping rather than blindly copying a temporary
DB over live data; migrate/restart and verify close/reopen, completion-and-next,
and private Triten context. No deployment, external project writes or commits
are authorized by this checkpoint.
