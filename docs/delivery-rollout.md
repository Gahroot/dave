# Delivery coordination checkpoint: 9 September 2026

## Current behavior and verification

Project-agnostic, coordination-only delivery is implemented on schema v6. It works
without credentials: chosen focus, finish criteria, prerequisites, imported bounded
plans, persisted handoff identities, structured results, explicit human review,
upstream invalidation, and a finite ready-for-pilot-review state. External projects
remain read-only. No agent runner, deployment surface or automatic provider request
was added. Queue exhaustion no longer triggers model continuation, even in legacy mode.

`npm test`: **288 tests across 29 files**; `npm run typecheck`, `npm run build`,
and `git diff --check` passed. New tests exercise real SQLite and guarded Fastify
routes, genuine v5 rollback/restore/upgrades, semantic-goal invalidation, exact result
retry, tampered bindings, independent branches, failed/unknown evidence, hidden
projects, nested-document rejection, and two differently named synthetic projects.
Historical completions do not become finish-line acceptance. The new focus-read
namespace inherits same-origin checks; a regression test first reproduced the
missing guard, then passed after extending the shared boundary.

The legacy delivery browser flow and the new `test/coordination-ui-walkthrough.mjs`
passed against isolated fixture storage in Chromium 148.0.7778.96. The latter
exercised local setup, reviewed plan/result imports, clipboard denial, stale save,
response loss after a real save, exact retry, three separate human acceptance
commands, unresolved prerequisites, terminal readiness, reload and chosen Today
focus. It observed zero provider POST requests and no page exceptions. Native
keyboard activation, 320px and 200% root text reflow were exercised. Screenshots
are ignored under `.ezcoder/screenshots/coordination`; failed captures from early
harness-label mismatches are historical artifacts, not final acceptance evidence.

## Real-code inspiration, not imported execution

Requested Steroids search/show inspected MCPJam/inspector's
`mcpjam-inspector/client/src/components/shared/actionable-insights/actionable-findings-panel.tsx`
(`buildTaskPrompt`): one assignment carries scope, criteria, evidence and guardrails.
grep MCP located elizaOS/eliza's
`plugins/plugin-agent-orchestrator/src/services/completion-envelope.ts` and
`independent-verifier.ts`; the latter was read directly from upstream source.
These informed strict per-criterion results and the distinction between reporting
and review. Backlog.md's `src/utils/task-edit-builder.ts` provided a smaller
criteria-versus-summary comparison. DAVE reuses its own transactions and clipboard
primitives instead of adopting those projects' execution engines. Prompts are not
sandboxes, and another agent's report is not automatically trusted verification.

## Local rollout performed

Inventoried the normal DAVE database and found no active writers/listener before
rollout. It was actually v4, not the v5 preview. Took a fresh SQLite-consistent local
snapshot, restored it separately, migrated the restored copy to v6, and compared
row counts and full-row hashes for every old data table. Restore plus upgrade and
comparison took **77ms** on this machine. The original was then upgraded; all eight
prior data tables matched, integrity/foreign-key checks passed, and close/reopen
worked. The backup and restored copy remain private outside version control.
This is a local pre-upgrade recovery point, not off-device protection or a promised
recovery-time objective.

The chosen first project now has four bounded capabilities, five finish criteria,
four unresolved live-pilot prerequisites, and one prepared handoff. Zero capabilities
were marked accepted. Its newer unfinished project plan, rather than an obsolete
business-workflow proposal, informed the private setup after the user approved using
unfinished work read-only. No project files, live credentials, client content,
project commands, migrations/backfills, Graph calls, inference or deployments were
used during setup. Private setup and rollout evidence remain under `.ezcoder/`.

## Remaining real-world proof

A prepared assignment is not execution. The operator still transfers work/results
and explicitly accepts evidence. Real source permissions, data handling/spending
approval, representative ground truth, restore targets and pilot reviewers remain
unresolved prerequisites. No actual client pilot, live provider entitlement,
screen-reader walkthrough, full accessibility audit, or measured reduction in the
operator's weekly effort is claimed. DAVE cannot honestly claim to finish the
external project without that work and approval.

## Historical checkpoint (superseded): 8 September 2026

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
