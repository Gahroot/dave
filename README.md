# Portfolio Command Center

Open one ranked decision queue, find the project context, and remember what you
handled. No setup forms, model calls, agent installation or business metadata.
It reads existing EZBoss, EZCoder, pew2 and Git evidence. A quiet queue is valid.

## Run it

```bash
npm ci
npm start          # builds the UI and serves it on http://127.0.0.1:4317
```

Loopback only — it reads private local state. `PORT` and `PCC_HOME` override the
defaults. Other scripts: `npm test`, `npm run typecheck`, `npm run dev`.

Use Node 24, the verified runtime, with its built-in `node:sqlite`.
`PCC_HOME` moves only app storage; it does **not** isolate external discovery.
Fixtures must also pass an isolated home to `sourcePaths(home, appHome)`.
For hot-reloading development, run `npm run server` and `npm run dev` separately.
The server alone serves the last built UI; Vite proxies API requests to port 4317.

## Read-only discovery and opt-in execution

- **Discovery is still read-only.** Portfolio scans, summaries and manual handoffs
  never execute project commands or modify external sources.
- **Agent desk is an explicit execution mode.** When enabled, user-authorized
  assignments create Git worktrees, launch the installed ACP agent, resume its
  conversations and run approved checks. This writes Git worktree/branch metadata
  and the agent's own session storage. It is not a sandbox.
- **The command center maintains its own storage automatically.** Summaries and
  rankings are generated and refreshed without you. You are not its database
  administrator.

## Connected agent platform

1. Open **Agent desk**. Review the execution risk, enable execution, uncheck
   **Pause new starts**, and save. Execution is disabled by default; every server
   restart pauses new starts until you explicitly resume.
2. Queue an assignment for a discovered, clean Git repository. Include acceptance
   criteria and, optionally, approved checks as JSON argument arrays, e.g.
   `[{"label":"Tests","command":"npm","args":["test"]}]`. No shell interpolation.
   Git identity/commits and dependency installation remain your responsibility.
3. DAVE creates `PCC_HOME/workspaces/<run-id>` on branch `dave/<run-id>`. The original
   checkout must be clean so uncommitted work is never silently excluded. Nothing
   is automatically committed, merged, deployed or deleted.
4. Follow the run's activity. Permission requests from compatible ACP providers
   appear as one-time choices. EZCoder currently auto-approves its own tools; its
   messages/questions are addressed by replying after the turn ends.
5. Inspect the diff and agent response, run configured checks, then reply/request
   changes in the same session or explicitly accept the exact workspace evidence.
   Acceptance requires every configured check to pass; manual-only review requires
   a separate acknowledgement. Source changes invalidate prior check evidence.
6. Failed/interrupted runs stay visible. Retry is explicit; disconnected runs also
   require confirmation that previous work stopped. **Close without accepting**
   retains the history and workspace without claiming completion.

The initial runner is installed **EZCoder ACP** (`ezcoder acp`). Authenticate and
configure it using its own tools; DAVE does not handle its credentials. Optional
`DAVE_AGENT_COMMAND=/absolute/path/to/acp-wrapper` changes the executable; DAVE passes
`acp` as its argument. Other wrappers must implement ACP v1 session loading; they
are not verified integrations. Claude/Codex-native adapters, terminal emulation,
auto-merge, remote workers and operating-system sandboxing are not implemented.

Limits: 2 active runs globally / 1 per project / review backlog 3 by default,
configurable in Agent desk; up to 100 unresolved assignments and 12 turns each.
Dependencies start only after human acceptance. Acceptance does not integrate code
into another worktree: dependent assignments start from the original checkout's
current HEAD, so integrate prerequisite changes outside DAVE before dispatching
code-dependent work. Pause dispatch while doing that. Limits count DAVE-owned
runs, not arbitrary delegation inside an agent. Check processes time out after
2 minutes; agent turns default to 30 minutes. Stored output is capped at 2,000
chunks / approximately 1 MB per run, displayed activity at 500 events. Large
changes fail review explicitly rather than pretending to provide complete evidence.

Agents/checks run with your local account's privileges and can use the network,
read credentials and incur provider charges. Worktrees are file separation, not
access control. The process guardian ends the owned process group on stop, timeout
or server-pipe loss; intentionally detached grandchildren can escape that group.
Do not enable execution for untrusted repositories or untrusted agent programs.
Agent requests cannot grant persistent permissions through DAVE. Common credential
patterns are redacted from output, but arbitrary secrets/private prose cannot be
reliably recognized; all run history stays in the local app database.

Migration v9 adds tables without rewriting delivery history. Existing migration
backups cover pre-upgrade committed state on this machine, not off-device disaster
recovery. Workspaces are retained; disk usage requires operator management.

Implementation plan and provenance: [docs/agent-platform-plan.md](docs/agent-platform-plan.md).

## Bounded delivery coordination (optional)

DAVE can coordinate any discovered project without a model connection. Manual
copy/import remains available without execution. Alternatively, **Run this assignment
in DAVE** opens Agent desk with the exact handoff. Valid structured reports return
automatically; reported success never automatically accepts the milestone.

1. Open the project, save its goal/user/workflow/stage with **Local coordination**,
   then choose **Start delivering this**. Inbox tracks this delivery alongside your other active projects.
2. Define 2–12 observable finish criteria, exclusions, and named human prerequisites.
   Map criteria to milestones; unmapped criteria remain visibly uncovered.
3. **Copy planning assignment**, review the returned 3–6-milestone JSON, and import
   it locally. Existing code and dated reports are leads, not verified completion.
4. **Prepare this assignment** persists its identity before copying. Only dependency-
   ready, unblocked work is eligible. A separate review assignment is available.
5. Paste the exact result JSON and review its preview. Saving never accepts work.
   Failed/unrun checks, unknown criteria, and reported blockers prevent acceptance.
6. Review all reported evidence and risks; explicitly accept or return the capability.
   Returning or blocking upstream work invalidates dependent acceptance and handoffs,
   but keeps reports. Changed goals/contracts/plans require fresh evidence.
7. After all mapped criteria, milestones, and prerequisites are user-accepted, DAVE
   stops at **Ready for pilot review**. This is not client signoff or a launch claim.

A report contains a version, project/plan/milestone/handoff IDs, per-criterion
observations, command strings/exit codes, blockers and risks. Commands and paths
remain inert text. Empty command arrays support manual observations; listed unrun
commands must have a null exit code, not zero. Exact retries after a lost response
are deduplicated. On conflict, reload saved state; drafts remain until you clear them.

Optional model planning still requires an explicit provider/model and exact context
approval. Selected nested `docs/` or `doc/` Markdown can be reviewed locally by exact
path (8KB maximum); excluded/private names and symlinks outside the project fail
closed. This is not a recursive repository audit. Context uses excerpts and names
its truncation. No task lists, credentials, client uploads, or agent-state documents
are approved through this feature. Completion never automatically calls a provider.

Legacy reports remain available as **Legacy milestone queue and reports** until a
finish contract is adopted. They are historical claims, not grandfathered acceptance.

## Daily flow

1. **Decisions** shows up to three recommendations from one persisted queue.
   **All** and the remaining count expose the rest; there is no separate Inbox.
   Coverage appears first, including waiting projects outside the scan.
2. Read the observed request and suggested next step. Human-waiting labels are
   inferences from unresolved task text, not invented answers to missing decisions.
   A useful blocker reason creates an inspection suggestion.
3. **View project** opens matching details in one click. **Projects** searches
   names and canonical paths; hash destinations survive reload and Back/Forward.
4. **Copy path** or **Copy handoff** prepares bounded plain-text context, including
   directory, request, next step, timestamps and source identity. Code and recognizable
   credential patterns are omitted. Review context before sharing; arbitrary sensitive
   prose cannot be reliably recognized. Clipboard denial leaves selectable text.
   These copy actions do not launch an editor, shell command or agent.
5. **Handled** acknowledges this evidence locally. **Tomorrow** stores 09:00 on
   the next local calendar day; its absolute deadline appears in History.
   **Not relevant** dismisses the revision. **Undo** reopens the same revision
   only if it remains current. None of these completes an upstream task.

Unchanged refreshes and restarts do not resurrect handled work. Meaningfully
changed requests produce new revisions; unrelated activity and observation times
alone do not. Disappeared conditions become inactive only after successful source
observation. History remains when projects go missing or leave the active scan.
The first scan establishes a seen baseline. Only displayed, visible queue items
are marked seen; background refresh does not acknowledge work.

Running tasks, pending counts, dirty files, concurrent task records, completed
work, and failures found only in a session opening create **no automatic human
obligation**. Completed tasks are excluded. Explicit review requests in unresolved
task evidence can qualify. Technical activity remains available in project details.

## How projects are ranked

Automatically, by evidence that work is live right now:

| Evidence | Weight |
|---|---|
| Unresolved explicit human request | 100; selected ahead of ordinary activity |
| Worker mid-run | 40 |
| Agent session in the last 24h | 30 (tapering to 6 by three weeks) |
| Recent commit | 20 (tapering to 5) |
| Pending tasks | up to 20 |
| Repeated activity across separate days | up to 18 |
| Blocked tasks | 15 |
| Uncommitted work after a recent session | 12 |

Score ≥ 30 makes a non-hidden project eligible for the **active deep scan**, capped
at **12**. One shared selection rule ranks explicit human requests first, with
stable ties. Cheap activity facts remain available for all discovered projects.
Only the active set receives deep reads and generates new queue revisions.

Coverage separates **checked**, **cached / not deep checked**, and **unavailable**.
More waiting projects than fit in the cap produce a warning linked to the filtered
directory, not an all-clear. Missing projects retain their last known context.
A task/discovery read failure conservatively prevents absence-based reconciliation
for that scan; per-source reconciliation and rotating scan coverage are deferred.
Absence of business metadata never costs a project a point.

### Optional controls

Expand a project to pin, hide or correct a summary. Corrections survive
regeneration. Pinning influences selection but does not override the cap or the
priority of explicit human requests. Hidden projects remain searchable in the
directory and are excluded from new queue generation.

## Technical activity vs. progress

Commits, changed files, agent sessions and task updates are labelled
**Technical activity**. They prove files moved, not that the work advanced. Task
and session evidence is used to explain what that activity was probably about.

## Refresh and evidence limits

GET requests reuse snapshots younger than 60 seconds and coalesce one refresh
when stale. The page updates at most once a minute while visible and checks on
return. **Pause auto-updates** stops automatic requests. Hidden tabs do not poll.
Local queue actions update stored state without an external rescan. Snooze expiry
is evaluated even for cached responses. Failed refreshes preserve the last usable
snapshot and offer Retry. A focused decision stays in place until an explicitly
prepared update is applied.

Deep reads are bounded to the selected active projects. Fingerprints avoid
unnecessary summary regeneration, **not** all rereads: scans must observe sources
to detect changes. Sessions use the opening 16 KB of the newest five files, not
latest outcomes or full transcripts. Historical failures are explicitly uncertain.
Scaffolding and contentless approval replies are filtered out.

## Sources

| Source | Path | What is taken |
|---|---|---|
| EZBoss links | `~/.ezcoder/boss/links.json` | project name + path |
| EZBoss plan | `~/.ezcoder/boss/plan.json` | task title, status, short summary |
| EZCoder tasks | `~/.ezcoder/tasks/projects/*/{meta,tasks}.json` | project path/name, tasks |
| EZCoder sessions | `~/.ezcoder/sessions/*/` | timestamps, counts, active days, opening request |
| EZCoder app | `~/.ezcoder/ezcoder-app-workspace.json` | open window cwds (not project evidence) |
| pew2 | `~/.pew2/known-projects.json` | project paths |
| Git | each project's own repo | branch, dirty count, recent commit subjects |
| Project files | selected active projects | bounded README and planning-doc evidence |

### What counts as a project

A directory with its own evidence: a git repository, an EZCoder record, an
EZBoss link, a pew2 registration, or an agent session bound to that directory.
Home, anything above it, and directories that merely contain other projects are
excluded. An open editor window is not evidence.

### Never read

`~/.ezcoder/projects.json` (live API keys), `auth.json`, `credentials.json`,
`.env*`, `*.secret`, `*.pem`, `*.key`, dependency folders, build output and VCS
internals. The deny-list throws before a file handle is opened.

Git runs through one chokepoint with an allow-list of exact argv shapes,
`execFile` with no shell, `--no-optional-locks`, `GIT_OPTIONAL_LOCKS=0`, 5s
timeout. Any other argv throws before a process is spawned.

`test/read-only-guarantee.test.ts` proves this: it runs the full workflow —
refresh, summarize, pin, correct, handled, snooze, undo, seen and handoff, then requires a size + mtime +
sha256 fingerprint of an entire fixture home to be unchanged, while a spawn spy
checks every argv and a read spy checks no deny-listed file and nothing in
`node_modules` was opened.

## Storage and migration protection

Schema v4 adds attention columns without rebuilding v3 tables or changing existing
IDs, edits, inbox outcomes or snapshots. Exact legacy evidence can inherit its
saved outcome; unmapped legacy rows stay in history. Only pre-v3 stores enter the
old setup-table cleanup. Databases newer than this app are refused.

Before migrating an existing store, SQLite creates a consistent app-local backup
under `PCC_HOME/backups` using native `VACUUM INTO`, including committed WAL data.
Backup failure aborts migration. The migration and version update run transactionally.
Fixture tests restore the backup into a separate database and inspect its contents.
These are migration rollback copies on the same machine, **not** off-device disaster
recovery or protection from disk loss. Never overwrite a live store to inspect a backup.

## Verification

`npm test`, `npm run typecheck`, and `npm run build` pass. Tests cover additive
migration/rollback/restore, revision outcomes, cached snooze expiry, invalid API
actions, refresh failures/coalescing, 50-project coverage and external read-only behavior.

For synthetic browser evidence, start `node --experimental-strip-types test/ui-fixture.ts`
on port 4318. With an already-installed Playwright module, run
`PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/ui-walkthrough.mjs`.
No Playwright dependency was added to this app. This exercises keyboard navigation,
clipboard denial, handling/Undo, Back/Forward, 320px and 200% text, empty/error/retry,
and visible-only automatic updates. Screenshots are synthetic and ignored.
See `DESIGN.md` for measured versus unverified acceptance, including the real-project
check and the remaining screen-reader/audit gaps. No WCAG conformance claim.

## Layering

```
adapters/ → core/ (detect, relevance, evidence) → model/ (summarize, inbox) → db/ → attention/ → server/ → ui/
```

Each adapter returns `{ data, issues[] }`, so a corrupt file or a vanished
project costs its own data and one row in Issues — never the whole dashboard.

## Limitations

- Claude Code and Codex session directories are not read yet.
- Relevance weights are a fixed table, not a model.
- Project identity is per canonical path, so moving a project mints a new id.
- Summaries derive from the opening request of a session, not the full
  transcript, so a session that changed direction mid-way reports its start.
