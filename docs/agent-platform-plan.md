# DAVE connected agent platform

## Objective and boundary
Keep cross-project awareness; replace manual handoffs with connected execution and review. Existing uncommitted work is the authorized baseline. No live project runs, publishing, commits, dependency additions, or destructive workspace cleanup during implementation.

Execution is an explicit exception to read-only discovery: an opted-in local operator queues work into an app-owned Git worktree. Agent credentials remain in the agent's own installation. Worktrees are not security sandboxes. EZCoder ACP currently executes without interactive permission gates; enabling execution must disclose this. No silent permission bypass flags.

## Step-by-step implementation (completed)
1. **Durable assignments:** additive migration v9; assignments, dependencies, events, review packets, settings, idempotent enqueue, revision-checked actions, restart reconciliation. Preserve v8 data and migration backups.
2. **Connected execution:** stdio ACP adapter using installed EZCoder; session initialization/loading, bounded event transport, permission requests where supported, follow-up turns, cancellation, timeout and owned process teardown. Executable configured locally, never from agent output.
3. **Task workspaces and scheduling:** unique worktree/branch per assignment; record creation before git side effects; global/per-project caps, dependency acceptance, review-backlog backpressure, pause/resume; no automatic retry or destructive cleanup. Recovery requires explicit operator action after interrupted runs.
4. **Evidence-backed review:** capture base/head and working-tree fingerprint, changed files and bounded diff; execute only operator-specified check argument arrays; save exit codes/output with fingerprint; reject stale acceptance or failed checks; human criterion confirmation and reason; returning work resumes the same session/worktree. Acceptance is not merge/deploy.
5. **Cross-project attention UI:** one Agent desk screen with attention-first list, deep-linked detail, create form, runtime risk consent/settings, live activity, reply/permission/stop controls, checks/diff and accept/return. Connect delivery handoffs to runs and automatically import valid structured reports without accepting milestones automatically. Keep manual workflows as fallback.
6. **Verification and documentation:** temporary repositories and a real fixture ACP subprocess exercise enqueue → isolated edits → waiting/reply → checks → stale-evidence rejection; scheduling/dependencies, idempotency, CSRF, migration rollback, cancellation/restart. Run full tests, typecheck, build, rendered desktop/narrow inspection. Update project boundaries and usage. Document unavailable live-provider/assistive-technology checks honestly.

## Implementation evidence and provenance
- Steroids executable is not on PATH; connected Steroids corpus tool used instead (no repositories indexed).
- Steroids: BradGroux/veritas-kanban `cli/src/commands/acp.ts`: durable task/session/run association and rejecting overlapping turns; `server/src/services/worktree-service.ts` lines 299–355: persist creation intent before argv-based worktree creation and record partial failure. Patterns reimplemented; no source copied.
- Installed `@prestyj/cli/dist/modes/acp-mode.js`: protocol version 1; initialize, session/new, session/load, session/prompt, session/cancel; stdout NDJSON; no permission gates in current EZCoder. Implementation must not imply stronger isolation than provided.
- cmux: actionable attention routing, not token-by-token notifications.
- Conductor/Superset: assignment workspace plus nearby review.
- Symphony: bounded dispatch and explicit reconciliation, not autonomous manager prompts.

## Success criteria
- User can queue work for a discovered project, observe a real process, reply in its conversation, stop/retry, and inspect actual workspace changes without copy/paste.
- Runs are durable; no second dispatch of the same assignment; interrupted work is visible rather than silently restarted.
- Checks and acceptance refer to the exact observed workspace; agent reports alone never imply acceptance.
- Existing portfolio and delivery functionality and user baseline remain intact.

## Delivered modules
- `src/agents/`: durable store, ACP client, owned-process guardian, worktree evidence, single-runtime lock and scheduler.
- `src/db/migrations/009-agent-platform.ts`: additive run/settings/dependency/event/review/packet tables. Packet replacement is transactional and preserves up to 200 historical snapshots per assignment.
- `src/server/agent-routes.ts`: guarded API and delivery handoff/report bridge. Agent-reported command strings never become executable checks.
- `src/ui/sections/AgentPlatform.tsx` and `AgentAttention.tsx`: desk/detail/review and cross-project attention on Decisions.
- Execution stays disabled until operator consent. Restart pauses dispatch. No workspace cleanup, auto-commit, merge, deployment or automatic paid retry.

## Verification evidence (22 September 2026)
- **RUNTIME:** `npm run typecheck`, `npm run build`, `npm test`, `git diff --check` passed. 315 tests across 31 files. 17 connected-agent tests and one v8 migration/restore test are new.
- **RUNTIME:** real fixture ACP processes and temporary Git repositories exercised worktree edits, one-time permission responses, same-session follow-up, configured checks, failed/stale evidence rejection, retained history/transaction rollback, scheduling/dependencies/backpressure, idempotency, output limits, restart recovery, group termination, timeout/guardian pipe loss, browser request guards, and automatic delivery report import without milestone acceptance.
- **RUNTIME:** populated v8 fixture restored from the pre-migration backup and integrity checked in 4 ms in the last full run. This is a small local fixture restore, not a production recovery-time claim or off-device backup.
- **RUNTIME:** production dependency audit reported zero advisories. Full audit reported two existing moderate development-tool advisories. Dependencies were installed from the existing lockfile with approval; no dependency/lockfile upgrade was made.
- **CODE:** runner protocol checked against the installed EZCoder ACP implementation and the Steroids corpus examples cited above. No upstream implementation was copied.

### UI verification
`test/run-ui-check.mjs` starts and stops the isolated fixture and runs its browser walkthrough. The agent fixture uses port 4323; delivery and coordination use port 4320, so run them sequentially. The harness supplies the agent fixture PID and restart-readiness IPC channel; do not run the agent walkthrough directly.

Prerequisite: an existing Playwright installation with a compatible Chromium browser. By default the walkthroughs import `playwright` and use its installed Chromium. For an installation outside this project's module path, set `PLAYWRIGHT_MODULE` to its module specifier or absolute `file:` URL; optionally set `PLAYWRIGHT_EXECUTABLE` to an existing Chromium executable. These checks never install packages or download browsers.

```sh
npm run build
node test/run-ui-check.mjs agent
node test/run-ui-check.mjs coordination
node test/run-ui-check.mjs delivery
```

Observed passes: execution consent, retained draft after a rejected request, queue/run permission, checks, criterion confirmation, acceptance and reload/deep-link persistence, keyboard activation, no page overflow at 320px/200% text and 768px, reduced-motion mode and forced-colors capture. Primary action text contrast measured 5.02:1. Screenshots are local ignored artifacts under `.ezcoder/screenshots/agent-platform/`.

Rendered critique: the first review screen overemphasized the transcript. The revision collapses activity at review time, keeps the diff/checks and human actions prominent, removes unrelated aggregate counters from detail, and reuses existing button geometry. Desktop/narrow captures were repeated after revision.

Rubric (0–2 each): specificity 2, hierarchy 2, composition 2, consistency 2, typography 2, surfaces 2, states 2, responsive behavior 2, accessibility 1, motion 2, authentic content 2, distinctiveness 1 = **22/24**. Accessibility is partial evidence, not a conformance claim: native labelled controls, keyboard activation, live-update pause, focusable named output regions, primary-action contrast and reflow were exercised; complete screen-reader/per-criterion/RTL/dark-theme assessment is unverified.

## Remaining boundaries, not hidden completion claims
- No live paid EZCoder model turn, provider authentication, actual-project execution, or productivity uplift measurement was performed. The end-to-end execution evidence uses a real local fixture subprocess, not provider mocks alone.
- EZCoder ACP is the initial integration. Other ACP wrappers are configurable but unverified; native Claude/Codex adapters and terminal emulation are not included.
- Git worktrees are not a security sandbox. Agent-native subprocesses that deliberately detach can escape the owned process group. Native account privileges and provider billing still apply.
- Acceptance is not merge. Dependencies gate dispatch, not transfer code: integrate required upstream changes into the original checkout before dependent coding assignments start.
- Workspaces and evidence are retained. There is no automatic disk cleanup, ongoing off-device backup, or disaster recovery guarantee.
- Existing uncommitted work was preserved as the authorized baseline. Nothing was committed or published.
