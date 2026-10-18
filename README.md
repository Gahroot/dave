# Portfolio Command Center

Open one ranked decision queue, find the project context, and remember what you
handled. No setup forms, model calls, agent installation or business metadata.
It reads existing EZBoss, EZCoder, pew2 and Git evidence. A quiet queue is valid.
The opt-in extras below (delivery planning, Agent desk, Fathom meetings, Talk to DAVE)
change this only after you connect them.

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

## Fathom meetings (optional)

Connect Fathom in **Connections** to track what you promised clients and what they
asked for. Nothing happens until you add a key; nothing is sent to a model until you
turn analysis on.

- **Import.** Every 5 minutes DAVE lists meetings *you* recorded (`recorded_by` your
  Fathom email) and fetches each transcript, at most 4 a minute. It never requests
  Fathom's own summaries or action items. The first sync imports 7, 30 or 90 days.
  Delivery is polling only: DAVE listens on your machine, so no webhook is used.
- **Key.** Stored in the macOS Keychain (`com.dave.meetings.fathom`), never in the
  database, logs, responses or git. Fixed `https://api.fathom.ai/external/v1` URLs,
  15 s timeout, 5 MB response cap, no redirects, digits-only recording ids.
- **Analysis (opt-in).** With the switch on, DAVE sends each new transcript (names
  and roles, no emails) plus your project names and open promises to your OpenAI
  connection, with its own prompt and your editable reading instructions. The switch
  shows exactly what is sent; changing that text asks for consent again. While off,
  meetings are imported but not analyzed, and you can analyze one at a time.
- **Checks.** Every item needs a verbatim quote found near its timestamp, promises
  must be spoken by you and client asks by an external attendee, projects are
  referenced by handles DAVE maps back, and dates must be plausible. Failing items
  are dropped and counted.
- **Promises vs. ideas.** Only something you clearly agreed to deliver to a specific
  person counts as a promise ("I'll send the export by Friday"). Maybes, "we could",
  "it would be nice" and brainstorming are kept as **ideas** and shown collapsed under
  "Ideas mentioned (not promises)". Ideas never reach the Inbox, follow-up checks,
  roadmaps or the plan. **It's a promise** / **Just an idea** flips one in a click (or
  by voice), re-analysis keeps your choice, and promoting an idea back restores its
  plan commitment unless you had closed it on purpose. Meetings analyzed before this
  change get the same rule-based reading straight away.
- **Promises.** Open, overdue, due soon, or "not followed up" (7+ days, no work on
  the project since). Evidence (a later meeting, commits, accepted Agent desk runs,
  finished milestones, done EZBoss tasks) only moves a promise to **Looks done?**;
  you confirm. The 6-hourly follow-up check uses the model only with the switch on.
- **Where it shows.** Inbox and Today (promises 60 to 90, client ideas 45), the
  **Meetings** page, and a "From meetings" panel on each project's Work tab. A client
  pain point's feature idea can open an editable Agent desk draft; you start it.
- **Forget and disconnect.** "Forget meeting" deletes its transcript and items and
  prevents re-import. Disconnect removes the key and can keep or delete meetings.
  Transcripts stay in `pcc.db` (and its migration backups) on this Mac.

## Clean up

Meeting analysis picks up many small promises that never mattered, and some of them
then show as Overdue. **Clean up** in the rail, with a count of what looks like noise,
lists them in six groups: overdue promises, old promises with no date (meeting at least
3 weeks ago), ones DAVE thinks look done, old client asks (meeting at least 30 days
ago), drafted decisions from meetings, and ideas that were never promises. Filter by
project, meeting or text, use **Select all**
per group, then **Clear N selected** or **Mark N done**. There is no confirm dialog: the
click is the decision, and **Undo** is right there and under "Recent clean-ups".

- **Clearing is not deleting.** A cleared meeting promise is marked dropped by you, so it
  leaves Meetings, the Inbox, Focus and the ranking, and re-analysis keeps it dropped.
- **One click clears it everywhere.** The same sentence can appear as a meeting promise,
  an Inbox row, an inferred plan item and a "Confirm commitment" decision. Clean up
  closes all of them together and logs one change per project. A plan item stays open if
  it has another open meeting source, if you locked it, or if you added or confirmed it.
  Those are reported as kept.
- **Fewer duplicates from now on.** Closing a meeting promise yourself closes its
  inferred plan item directly, with no "Drop as obsolete" decision. Rejecting a "Confirm
  commitment" decision also drops its open meeting promise.
- **Undo is safe.** Undo restores only items still exactly as the clean-up left them, so
  anything you changed since is never overwritten.
- Promises you confirmed or edited are hidden unless you switch on "Include ones you
  confirmed", and they are never preselected. Clean up never runs on its own.
- **By voice.** DAVE's voice and Pew can preview and clear noise by group (including
  ideas), project, meeting, age or text, and undo it. Each clean-up needs your yes, and
  applies exactly the items it previewed.

Code: `src/triage/`, `src/server/triage-routes.ts`, `src/ui/sections/CleanupView.tsx`,
`src/ui/cleanup-model.ts`. Entry links sit on Focus ("Clean up drafted decisions",
"Clean up overdue promises") and in Meetings ("Clean up in bulk").

## Talk to DAVE (optional)

A voice partner for setting and refining each project's finish line, what gets you
paid and what matters most right now. Open it with **Talk to DAVE** in the rail, the
dark puck at the bottom right of every page, `Alt+Shift+D`, or `#voice` for a full
page. You can also type. The session keeps going while you move between pages.

- **Connection.** Voice uses the OpenAI connection from **Connections** (ChatGPT
  sign-in, tokens in the Keychain). On **Talk**, the server mints a 10-minute
  ephemeral secret from `/v1/realtime/client_secrets`. Only that `ek_` secret reaches
  the browser, which talks to `/v1/realtime/calls` over WebRTC. There is no API-key
  fallback: if your plan is refused, the panel says so (401 → reconnect, 403 → not
  available on this plan). `DAVE_VOICE=off` turns voice off. Defaults:
  `gpt-realtime-2.1`, voice `marin`, hands-free (push-to-talk with Space is a setting).
- **What leaves this Mac.** Your conversation, DAVE's tool results and any document
  DAVE reads for you go to OpenAI Realtime on your ChatGPT account; the line under
  **Talk** says this. Meeting transcripts and verbatim quotes are never sent, only
  DAVE's wording of meeting items. Every model-facing string passes `speakable()`
  (`src/voice/safety.ts`), which redacts secrets and drops URLs, paths and code.
  Voice transcripts and summaries stay in `pcc.db` (last 100 sessions, 2,000 actions).
- **Writes need a yes.** Reads, `remember`, attaching a document, opening a page and
  pulling updates happen at once. Every other change (finish line, paid when,
  priority, focus, items, decisions, steps, Inbox and meeting items, pins, forgetting
  a note) only *prepares* on the first call. DAVE reads one sentence and asks "Okay?".
  Your spoken yes or the amber **Confirm** card runs exactly the stored action
  (single-use token, 2 minutes, bound to the session). Calls are journaled by call id,
  so a repeat returns the first result. Agent desk, Fathom keys, the OpenAI
  connection and hiding projects are not voice tools.
- **Approve all for this session.** Press **Approve all** on a confirm card, or say
  so yourself ("you have my approval", "don't ask, just do it"). From then on, changes apply at once and DAVE says what it did in
  one sentence. Any open confirm cards are accepted in order. A spoken grant counts
  only when your own last words contain it; text in a document, meeting item or tool
  result can never switch it on. While it is on, a banner on the stage and a badge on
  the dock show it. **Turn off** or "ask me again" ends it, and it always ends with the
  conversation. It is kept in memory only, and each switch is logged in the session
  history.
- **Clean up by voice.** "Clear out the old meeting promises" makes DAVE count the noise
  (`find_noise`) and prepare one `clean_up` card ("Clear 41 items", with the first
  titles). The card runs exactly the items it listed. "Undo that" restores the last
  clean-up.
- **Direction.** Each project's Focus page has a **Your direction** panel, which
  voice edits too: *Paid when*, *Priority* 1–5 and *Matters most now* (finish-line
  items), plus dated notes of what you told DAVE. They add visible reasons to the
  next-objective ranking (`/api/intel/focus`, the change log and DAVE's
  recommendations): a focus item +60, and priority #1 +45, #2 +30, #3 +18, #4 +8,
  #5 +0. Every change is logged as "Direction: …". The Focus home still orders
  projects by the behind score and shows priority and paid-when as labels.
- **Documents.** Drop, paste or pick contracts, photos and documents on the panel.
  `POST /api/files` takes raw bytes up to 25 MB, identifies the type by its content
  (PDF, PNG, JPEG, GIF, WebP, HEIC, DOCX, RTF, HTML, plain text; anything else is
  refused), and dedupes by sha256. Files go to `PCC_HOME/documents` (0600) with a
  1 GB total cap. Text comes from fixed macOS tools (`textutil`, PDFKit, Vision OCR)
  only on upload, with a 30 s timeout; other platforms keep the file without text.
  DAVE reads documents only when asked and can offer a contract's deliverables as the
  finish line. A small image is also sent as a picture.
- **Live news.** While a session is live, DAVE polls Focus every 90 seconds and tells
  the model about a new top objective or new decisions. Hands-free sessions end after
  5 minutes without speech.

Code: `src/voice/`, `src/documents/`, `src/server/{voice,document}-routes.ts`,
`src/ui/voice/`, `src/ui/mascot/` (the DAVE bot) and
`src/ui/sections/focus/DirectionPanel.tsx`. Tests use a fake fetch and a fake
extractor; nothing calls OpenAI or the Keychain.

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

Schema v14 (`src/db/migrations/014-triage.ts`) only adds the `triage_batches` table,
which records each clean-up and the before and after state of every row it changed, so
Undo works. Nothing existing is rewritten. The automatic `backups/v13-*.db` copy is the
way back.

Schema v13 (`src/db/migrations/013-voice.ts`) only adds tables: project direction and
notes, shared documents (metadata and extracted text; the files sit in
`PCC_HOME/documents`), voice settings, voice sessions and the voice action journal.
Nothing existing is rewritten. The automatic `backups/v12-*.db` copy is the way back.

Schema v12 adds delivery-leverage columns additively (item lane, goal, verified and
sent times, "Not right" count; outcome confirmation, start/target dates, delivery-step
marks and last demo). Two values are backfilled as approximations because the real
times were never stored: items already verified get `verified_at = updated_at`, and
every existing finish line (always written by a person) counts as confirmed at its
`updated_at`. The automatic `backups/v11-*.db` copy is the way back.

Schema v10 adds the meeting tables additively; a pre-v10 DAVE refuses the upgraded
store, and the automatic `backups/v9-*.db` copy is the way back. Schema v4 adds
attention columns without rebuilding v3 tables or changing existing
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

Voice has its own synthetic fixture. After `npm run build`, start
`node --experimental-strip-types test/voice-ui-fixture.ts` (port 4327; restart it for
each run because the walkthrough edits direction), then run
`PLAYWRIGHT_MODULE=… node test/voice-ui-walkthrough.mjs`. A fake provider and a fake
mint stand in for OpenAI, a fake WebRTC peer replaces the call, and `api.openai.com`
is routed to a local stub, so no audio or network leaves the machine. It checks the
dock, Direction reordering, session start (ephemeral secret, no model in the SDP URL,
no forbidden tools), confirm before write, PDF and PNG upload, typing, settings, history,
390 and 1440 px, contrast and 44 px targets on the stage (dark and light mode), and that the synthetic
ChatGPT token never appears in a response. The fixture also seeds synthetic meeting
noise. The walkthrough checks Approve all: the button accepts open cards, the next write
applies at once, a refused spoken grant offers the button, and approval ends with the
session. It also checks Clean up: the page and nav count, clearing a group lowers the
Inbox, Meetings and commitment counts, Undo restores them, voice `clean_up` and Undo
work, and the page fits at 390 px. It captures the 3D DAVE at hero (180 px) and dock (64 px)
size, plus a pose spun by dragging. Screenshots go to `.ezcoder/screenshots/voice/`.

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

## Next best action and roadmaps

**Focus** is the home: delivery projects most behind first, each with its next move
(see "Delivery order and task lists" below). The older single-objective view is still
computed for the change log and `GET /api/intel/focus`, but Focus no longer shows it.

The Inbox opens with one **Do this next** card: the single most valuable action across
agent runs, delivery steps, inbox items and roadmap gaps, with why it matters and what
"finished" means. Waiting and paused work never competes. Ranking is in
`src/ui/top-action.ts` (age only breaks ties inside a tier).

`GET /api/delivery/roadmaps` returns, per active delivery project, the finish line,
milestone/criterion progress and **gaps**: open promises and client asks from Fathom
meetings that no milestone, acceptance line or finish criterion covers (word-overlap
match in `src/model/roadmap.ts`, no model call). Gaps from meetings newer than the plan
are marked as new. Nothing is closed automatically.

## Closed loop: what moved, and the prepared next action

DAVE notices finished work on its own, checks it against the finish line, and keeps
one prepared next action ready. It never starts work itself.

- **Noticing work.** Every 60 s DAVE reads finished EZ Coder runs (the start and end
  of each session file) and new local commits, both read-only. Merged GitHub pull
  requests are opt-in: switch on "Check GitHub for merged pull requests" in
  **Connections** and DAVE runs read-only `gh pr list` with your existing sign-in every
  10 minutes. Work is matched to the plan through the `DAVE-Objective:` marker that
  DAVE's briefs and commit trailers carry, and otherwise by title.
- **What moved.** Each event gets a report on Focus: which plan items advanced, what is
  still missing (items, acceptance checks, delivery steps), and whether the next action
  changed. Code evidence only ever reaches "looks implemented"; verifying is yours.
- **Prepared next action.** The Focus hero shows one action, already prepared: a single
  main button, a draft where one helps (a message to chase a client, a verify
  checklist, a demo agenda, a brief for EZ Coder), what "done" means, the evidence it
  rests on and what DAVE couldn't confirm. Similar decisions arrive as one batch.
  **Skip** and **Later** take it off the list until the evidence changes or the date
  passes. "Hand to EZ Coder" is a brief to copy: DAVE refuses to start it.
- **Pew.** When you ask, Pew reads `GET /api/intel/briefing?caller=pew` for the next
  action, what moved since you last asked (remembered by DAVE, so restarts don't reset
  it) and the decisions waiting. With your spoken yes, Pew can answer, skip or defer
  that action and clean up noise. Only Pew starts EZ Coder, through its own
  `delegate_backlog_item` and after your yes.
- **How DAVE's picks compared with yours.** Every recommendation is logged and later
  marked followed, overridden, skipped, deferred, superseded or expired, with what you
  did instead. The panel on Focus shows the agreement rate, recent overrides and
  patterns, and can suggest a priority change. Nothing changes until you click it.

Code: `src/work/`, `src/intel/prepare.ts`, `src/intel/next.ts`, `src/intel/briefing.ts`,
`src/intel/ledger.ts`, `src/intel/review.ts`. Routes sit under the guarded `/api/intel`
prefix. For UI work, `node --experimental-strip-types test/fixtures/seed-ui.ts <tmp dir>`
builds an isolated fixture home, and `test/fixtures/serve-ui.ts <tmp dir>` (with `HOME`
and `PCC_HOME` set as it asks) serves it without schedulers, Keychain or network.

## Delivery order and task lists

DAVE's job here is to give a solo developer more capacity, not more admin. It only
suggests and produces text. It never launches EZcoder or an agent and never contacts
anyone. Logic lives in `src/intel/delivery.ts` and `src/intel/scope.ts`, which are pure:
the clock is passed in and iteration is sorted, so the same input gives the same output.

**Home order.** Projects with a confirmed finish line are ranked by a "most behind"
score from 0 to 100, highest first. Every row shows the score's parts:

- *Behind schedule* (50%): how far time used runs ahead of work done, between the start
  date (or the date the finish line was confirmed) and the target date. 100 once the
  target date has passed and the work isn't finished.
- *Distance from delivery* (30%): `100 − % done`.
- *Stalled* (20%): 7 points per day since real progress, capped at 100.

With no target date the last two parts are weighted 60/40, and "Set a target date"
becomes a move. One click accepts DAVE's suggestion, which is the latest due date
among finish-line items and your own commitments. Projects without a confirmed finish
line sit under **Needs a finish line**. Delivered projects sit under **Delivered**.
Money and payment terms are not part of the score. Your Direction priority and
paid-when show on the row but do not change this order (see "Talk to DAVE").

**% done.** Production-ready is worth 70%, split evenly across finish-line items, and an
item counts only once **you** mark it Verified. *Live*, *Client using it* and *Signed
off* are 10% each and are marked by you. Only verifying an item or marking a step
counts as real progress. EZcoder reporting a task done, or a matching commit, only makes
an item "looks built", which turns into a *Verify* move.

**Moves.** Moves are what only you can do: decide a proposal, chase a client blocker,
verify built work, rethink a task that came back "Not right" twice, mark the next
step, show verified work to the client (three or more unseen items, or production-ready
with any unseen), or set a target date. At most three show at once, and the rest sit
behind a disclosure. Until the finish line is confirmed, the only move is to confirm it.

**Lanes.** Each item is on the **Finish line**, **Extra** or **Phase 2**. Until you choose,
DAVE guesses from wording ("polish", "dark mode", "later", "v2" …) and labels the guess.
Your choice is stored and always wins. New client asks found in meetings are filed with
one click into any lane, or rejected. Extras and Phase 2 sit in a collapsed **Bells &
whistles** list with a pitch-ready copy and are never suggested as tasks.

**Suggested tasks.** Open finish-line work becomes an ordered list of standalone
EZcoder tasks:

```
So that <what the client gets>
Why: "<client's words>" (<meeting>) or the agreed finish line
Build: <item>
Done when:
- <acceptance line>
Context: <project>. Finish line: <…>. Stay within this task; do not deploy, merge or contact the client. Report what you changed and how you checked it.
```

Order: work already started, then the riskiest part (integrations, auth, payments,
migrations, deploys), then the earliest due date, then whatever unblocks the most. A
dependency that is ready comes first. Drafted goals and done-when lines are labelled
and editable, and changing a goal resets the "Not right" count. A task **pauses** under
"Paused until you answer" when it is blocked, waits on a client or third-party
blocker, waits on a pending conflict, deadline or scope decision, has come back "Not
right" twice, or depends on paused work. The question it waits on becomes one of your moves.

**Copying is sending.** *Copy all* or a single *Copy* records those tasks as sent, and
*Undo* or *Put back* reverses it. If the clipboard fails, the text stays selectable with
a *Mark as sent* button. A task that already matches an open EZcoder task by title (at
least 60% of significant words) shows as sent with "In EZcoder, matched by title".
*Verified* or *Not right* is one click. *Not right* reopens the item and puts it back on
the list. The demo move clears on the next linked meeting or with *Shown to the client*.

**Agreements.** Paste an agreement or statement of work under *Edit the finish line*.
`src/intel/agreement.ts` runs in the browser and pulls out deliverables (under scope,
deliverable or feature headings) and acceptance lines. It skips out-of-scope, payment
and legal sections. The pasted text never leaves the browser. Only the lines you tick
are saved.

Routes (all under the loopback and CSRF guard):

- `PUT /api/intel/projects/:id/schedule`: target and start date. Returns 409 until the finish line is confirmed.
- `POST /api/intel/projects/:id/steps`: mark *Live*, *Using* or *Signed off*.
- `POST /api/intel/projects/:id/demo`: shown to the client.
- `POST /api/intel/projects/:id/tasks/sent`: sent or put back. Every id must belong to the project.
- `POST /api/intel/projects/:id/finish-line`: add confirmed finish-line items. Duplicates are skipped and counted.
- `POST /api/intel/items/:itemId/verify` and `/reopen`.
- `PATCH /api/intel/items/:itemId`: now also accepts `lane` and `goal`.
- `POST /api/intel/proposals/:id/accept`: now accepts an optional `lane`.
