# DAVE workbench design

## Design read and direction

DAVE is a local, single-operator, data-dense application workspace. Developer-tool evidence inspection is secondary. Frequent short visits should follow one loop: **see attention → open work → act with context → review → return to the queue**. Errors can trigger paid execution or lose review context, so exact approval, provenance, recovery and drafts matter more than reducing click counts.

A calm workbench with a clear next action: project/work identity, reason and safe next action first; freshness, evidence and history second. A shared next-action row is the distinguishing device. No invented metrics, progress percentages, users or dates. No marketing hero, glass, decorative cards, tint-on-tint statuses, emoji or hover lift.

## Evidence

The approved Refero research inspected these references. They inform structure, not copied branding or claims of effectiveness:

- [Linear inbox flow 6682](https://refero.design/flows/6682), [screen](https://refero.design/pages/42256ca3-3d3b-452b-b445-a908e916d9fc): scan, select beside queue, act without losing position.
- [Linear project updates 6673](https://refero.design/flows/6673), [screen](https://refero.design/pages/f45f744c-7330-4dc1-b291-676f4dc17637): comparable rows, persistent context, contextual editing.
- [Linear project creation 6655](https://refero.design/flows/6655): bounded setup with essential fields before optional configuration. DAVE discovers projects; no project creation is added.
- [GitHub review](https://refero.design/pages/4b64c360-ee73-4c4e-91e2-1c7a9b923f8b): separate evidence navigation and final review. DAVE does not become an IDE or add merge/publish.
- Contrast: [review before confirm](https://refero.design/pages/48aaa05c-0d69-492e-9964-bc876505e2b3), named stages only for bounded setup, not ordinary navigation.

Source inspection found three separate home queues, setup above project context, long delivery/review stacks and equal-weight actions. Baseline synthetic screenshots: `.ezcoder/screenshots/redesign-baseline-1440.png` and `redesign-baseline-390.png`. These are runtime captures, not usability research.

## Action-first workspace revision (25 September 2026)

Audience: the project owner working on a small laptop with limited attention. Single job: identify and complete the next human action with sufficient evidence. Thesis: **one navigation rail, one work surface, one obvious next action**. First glance shows identity/state; second shows blockers and decisions; optional disclosures hold successful evidence, commands, history and sources. Failed/unknown/not-run results, risks and prerequisites remain visible before acceptance. Reported success is not independent verification.

Approved research visually inspected Linear directory `f45f744c-7330-4dc1-b291-676f4dc17637` (compact row hierarchy), overview `90976755-c162-49ac-ad72-a27cbccd0ae9` (one primary content rail), and inbox `42256ca3-3d3b-452b-b445-a908e916d9fc` (contrast: persistent three columns reproduce our space problem), plus flow 6669 for action feedback. These references are structural observations, not usability proof or copied assets.

Runtime baseline: build and existing synthetic workspace walkthrough passed before implementation. Captures `.ezcoder/screenshots/decisions-desktop.png`, `project-desktop.png` and the walkthrough's narrow captures show the old nested layout. Existing primary/secondary contrast samples: 5.02:1 / 6.43:1. No live source/provider actions. Baseline main JS 496.58 kB, lazy delivery 45.14 kB, CSS 212.95 kB. Prior acceptance results below are historical, not verification of this revision.

Retain Inter/Mantine/Lucide, shared shell gutters and 150ms named transitions. Reuse existing delivery workflow derivations and mutation owners; no new state machine, polling, dependency or backend capability. Keep drafts mounted across tabs, explicit consent, reasons, revision checks, locks and reviewed-import gates. No decorative metrics, nested card framing, hover lifts or automatic acceptance.

## Status language (3 October 2026)

The owner reported the previous revision still read as "walls of text": monochrome rows, 69% identical outlined buttons, no green anywhere, and the same sentence repeated on 11 of 12 inbox rows. Research: `.ezcoder/plans/scannable-ui-research.md` (Refero: Linear, GitHub Actions, Mercury, Cursor, Vercel, Attio, Krisp, n8n; Carbon and Atlassian status guidance). Thesis: **every state gets a color, an icon shape and a word; color answers "whose move is it".**

| Tone | Meaning | Token |
|---|---|---|
| Amber | Your move: review, permission, decision, due soon | `--tone-amber` #b45309 |
| Blue | Working, no decision needed; also the one accent | `--tone-blue` #1859b7 |
| Green | Done or passed (checks passed, accepted by you) | `--tone-green` #198038 |
| Red | Broken: failed, unavailable, overdue, blocker | `--tone-red` #c92a2a |
| Gray | Parked, queued, not run, cached, reported by an agent | `--tone-gray` #6a7584 |
| Violet | DAVE's guess: inferred request, "Looks done?" | `--tone-violet` #6741d9 |

Rules:

- One map owns every domain state: `src/ui/status.ts` (`RUN_STATUS`, `MILESTONE_STATUS`, `NEXT_STEP`, `CHECK_RESULT`, `CRITERION_REPORTED`, `FRESHNESS`, `INBOX_KIND`, `PROMISE_GROUP`, `ITEM_KIND`, `ITEM_STATUS`, `MEETING_STATUS`, `CONNECTION`). `test/ui-status.test.ts` checks every member is mapped and the honesty boundaries below hold.
- Render states only through `StatusIcon` / `StatusMark` (`components/Status.tsx`). Color paints the icon and a 3px row rail; text stays ink. No tinted pill fills (Mantine light badges were removed from `Labels` and `StaleBadge`).
- Rails only on amber, red and violet rows (`hasRail`). Calm states (blue, green, gray) never get a rail, so a rail always means "look here". Selection is a fill plus bold title, not a rail.
- Honesty boundaries are visual: cached is a dashed gray ring, never a green check; agent-reported criteria are gray with a bot icon ("Reported met"), never green; accepted is "Accepted, not merged". The run trust ladder keeps four facts apart: Agent finished (reported) → Checks passed → You accept → Merge or deploy (dashed, separate).
- Counts: tabs and filters carry `CountPill` (aria-hidden, so link names stay plain words); amber/red counts are solid only where the owner must act. Zero counts are hidden.
- Grouping: Inbox groups by category, then collapses identical asks under one header ("Needs your approval to publish… 11") so the sentence is read once. Paging follows the grouped order (`inboxDisplayOrder`).
- Buttons: one filled primary per decision region (often with an icon), outlined secondary, subtle tertiary, subtle red for destructive or "close without accepting". Mantine primary shade 8 now equals the CSS accent (one blue; white text 6.66:1).
- Contrast (measured): on white the six tones are 4.68–6.66:1; on the selected-row fill `#edf0f4` the lowest is gray at 4.09:1. Tones color icons and rails (3:1 required), never body text. Count pills: white on amber 5.02, on red 5.46; neutral pill text 9.72:1.
- Long explanations move to dimmed helper text or disclosures; required consequences ("Accepting does not merge or deploy") stay visible next to the primary action.

## Information architecture

Primary navigation: Inbox, Projects, Agent desk, Meetings. Secondary: Connections, Diagnostics.

- Inbox: one typed list with All, Needs decision, Ready to work and Waiting filters. Opening a request or delivery replaces the list at every width. Back restores filter, page, scroll and focus; unavailable items never substitute another selection. Agent items retain safe returns.
- Projects: compact searchable/filterable directory replaced by the selected workspace. Work is the default and loads delivery lazily. Reference contains editable notes and expandable sources. Legacy `delivery` selects Work; `overview` and `context` select Reference, with `context` opening sources. Keep hidden/pinned/waiting controls and reversible hiding.
- Delivery setup: Goal → Context → Review and plan. Existing plans open current work. Preview is local; exact approval precedes any explicit external generation.
- Coordination: next-action row, milestone sequence and focused active-stage panel. Connected and manual methods are distinct. Manual exchange remains exact JSON, then inspect, save, review, explicitly accept.
- Agent desk: runs first; secondary runtime settings. Assignment → Checks and dependencies → Review and start. Check executable and argument arrays remain separate. Run workspaces expose permissions, Activity, Changes, Checks and gated review.
- Connections: state-specific connect/restore/cancel/disconnect and storage consequences. Unsupported Claude stays unavailable. Diagnostics separates source failures from work blockers.
- Meetings: Your promises (Overdue, Due soon, Open, Looks done?), Client asks, the meeting list and Reading instructions. A meeting opens in place of the list with summary, direction, items grouped by kind, a project picker that can remember a company, Analyze, Import anyway and Forget. Fathom settings and the analysis switch live in Connections. Meeting rows also appear in the Inbox under Ready to work, with "Open in Meetings".

Hash navigation remains dependency-free. Legacy queue/item/delivery, projects/id/q/waiting, agents/id/project/handoff and issues/connections links survive. `meetings?section=&rec=` and `agents?view=new&meetingItem=` accept only known sections, digit recording ids and `mi-` item hashes. URL values are validated identifiers, filters and tabs only; no private prompts, results or tokens. Invalid selection shows recovery, never another item. Back/Forward and meaningful return focus are required.

## System and component map

User authorized migration from the actual React 18/Mantine 7/Tabler baseline to React 19/Mantine 8/Inter/Lucide. No other UI library is needed. Font files are self-hosted through the installed package; no external font requests.

Semantic roles: neutral light canvas, white working surfaces, dark ink, readable secondary ink, structural borders and restrained blue actions/focus. Spacing follows 4/8px; controls 32/40px desktop and 44px touch, radius 6–8px. Supporting text 14px, fields/body 16px. A 224px rail and one shared header/content gutter establish alignment. Data can fill the rail; prose and forms have a deliberate readable measure.

- `theme.ts` and `styles.css`: type, color, spacing, control, state, focus and motion owners.
- `WorkspaceShell`: navigation, drawer, skip link and shared content rail.
- `WorkspacePrimitives`: page header, next-action/status rows and empty states where repeated.
- `navigation.ts`: validated route parsing/link construction.
- `inbox-model.ts` / `useInboxData`: typed source identity and a single owner for queue reads.
- `ProjectWorkspace`: project tabs and scoped draft lifetime; existing `ProjectCard` notes/evidence retained.
- `LazyDeliveryView`: load delivery only when opened. `DeliveryView` remains the API/state owner; `DeliverySetup` handles presentation. Coordination panels retain shared parent state.
- `AgentPlatform`: lazy route/data owner; `AgentAssignment` and `AgentRunWorkspace` presentation.
- `MeetingsView` (lazy, sixth destination): owner for meeting reads and polling. Sections are links (`section=promises|asks|list|instructions`), a meeting is `rec=<digits>`. `MeetingDetail`, `MeetingInstructions` and `MeetingItemRow` present; `meetings-model.ts` holds pure grouping and labels. `FathomConnection` sits in Connections; `ProjectMeetings` adds "From meetings" to the project Work tab; `MeetingDisclosure` renders the server's exact disclosure text.
- Reuse `CopyText`, `EvidenceList`, `ProjectNextAction`, `Labels`, `StaleBadge`.
- `status.ts` + `components/Status.tsx`: the status language (marks, count pills, help tips, trust ladder, property rows). Shared classes in `styles.css`: `.row-main`/`.row-sub`/`.row-aside` (row anatomy), `.result-list`/`.result-row` (checks, criteria, files), `.count-strip`, `.milestone-strip`, `.step-dots`, `.property-list`, `.quiet-tag`, `.action-bar`.

Rows use ordinary links/buttons; tabs use accessible tab semantics. Status has text plus optional icon, count and timestamp; color never carries meaning alone. One primary action per decision region, secondary actions quieter. Borders separate structures rather than wrapping every subsection. Feedback transitions name color/opacity and use 120–180ms with reduced-motion equivalents. Native focus-visible is separate from selection; no blur or global suppression.

## Safety and domain boundaries

- Discovery is read-only. No external project mutation, live database migration, credential action, real execution or paid inference during verification. Agent execution is explicitly opt-in; worktrees are not security sandboxes.
- Preserve loopback/CSRF/origin controls, authorization, request validation and separate executable/arguments. Escaped React text is the only rendering path for model/tool/source output.
- Cached is not checked; a report is not independently verified evidence; passing checks is not human acceptance; acceptance is not commit, merge or deploy.
- Preserve exact packet/provider/model approval, reviewed document hashes, approval invalidation, revision conflicts, request locks, operation identities and idempotent retries. No automatic mutation retry or silent model fallback.
- Context is opt-in: bounded documents, canonical containment, regular-file/no-follow checks, secret screening, 64,000-byte packet cap. Only exact reviewed packet approval permits external generation. Regex screening cannot prove arbitrary text lacks private business data.
- Existing context collector caps (8 product plus 4 extra documents, 64KiB per file, 4,000-character excerpts), history bounds and source-denied paths remain backend-owned and unchanged.
- Drafts stay in project/run-scoped React owners, not browser storage. Tabs and polling do not replace drafts. Leaving dirty work requires discard/cancel; errors retain input.
- One owner per portfolio/inbox/run/operation polling loop, explicit pause/hidden-tab behavior, bounded output and cleanup. Agent and delivery code remain lazy.
- Request handling/dismissal records local attention decisions, not upstream task completion. Hidden projects are reversible local preferences, not deletion.
- Meetings: the Fathom key is write-only in the UI (a password field, never shown back). Transcripts never reach the browser; lists and details carry DAVE's analysis only. Every meeting item shows the verbatim quote, speaker and time beside DAVE's wording, so a wrong reading is visible. Nothing closes a promise without a click: evidence only asks "Looks done?" with a "Not yet" answer. Analysis consent shows the server's exact disclosure and requires a checkbox; a one-off analysis shows the same text for that meeting. A client idea opens an editable Agent desk draft; the normal approval step starts it.

## Responsive and accessibility contract

Inbox and Projects use one navigation rail and one work surface at every width, never a secondary list beside detail. Agent desk retains its existing master/detail layout. At 768px and below: compact header, accessible drawer and one pane. Verify 1440, 1280, 768, 390 and 320 CSS pixels. Long labels/paths wrap; only named intrinsic code/diff regions scroll horizontally. No sticky action may obscure focus or the mobile keyboard.

Scope: all destinations (Meetings added as the sixth) and all approved flows, including confirmations, loading, empty, filtered-empty, unavailable, cached, permission, pending, failed, retry, saved and selected states. Native semantics, labels, headings, current navigation, skip link, visible focus, keyboard order, modal focus return and restrained announcements are required. Polling never steals focus or announces unchanged output. Measure text/control/focus contrast, 200% text/zoom, 400% reflow, text spacing, reduced motion, forced colors, select insets and touch targets.

Browser automation is available through an installed Playwright module and Chromium executable. Safari/Firefox, real touch, VoiceOver and full per-criterion WCAG 2.2 A/AA evidence remain unverified until explicitly exercised. Automated checks and screenshots are not WCAG or ADA conformance. No accessibility certification is claimed.

## Acceptance matrix and evidence

| Gate | Required proof | Current status |
|---|---|---|
| Baseline | typecheck/tests/build; synthetic desktop/narrow | Passed: 315 tests / 31 files; JS 409.14 kB + lazy agent 37.88 kB; CSS 203.00 kB |
| Routes/inbox model | legacy/invalid links, safe return, failures, bounded counts, typed action tests | Passed in the 324-test suite; browser Back/Forward and invalid-selection recovery passed |
| Capability parity | all items in `.ezcoder/redesign-progress.md` reachable | Implemented and source-reviewed; runtime versus source-only coverage is itemized there |
| Six workflows | four existing isolated walkthroughs, fresh delivery/coordination fixtures | All four walkthroughs passed; extended coordination/agent walkthroughs additionally pass connected assignment/start, separate acceptance, stalled resend/take-back, pause/resume, stop/retry and interrupted recovery |
| Draft/retry safety | tabs/polling/failure/conflicts/duplicate submission tests | Tested paths passed; two completion requests produced one saved completion. Retained passing packets cannot satisfy missing/failed current checks; changed turns clear criteria, and manual-only acceptance requires acknowledgement |
| Responsive/keyboard | widths, focus, navigation, dialogs, native controls | Chromium passed at 1440/1280/768/390/320; keyboard activation, drawer/dialog return and select dismissal passed |
| Accessibility | changed-scope criterion evidence; manual assistive technology separately recorded | Partial evidence only: sampled contrast, keyboard, 200% root text, reflow, reduced motion and forced colors passed. Screen reader, real zoom, other platforms and full criterion audit remain unverified |
| Visual critique | desktop/narrow, revise weakest criterion, recapture; >=20/24 with no floor failure | Provisional 22/24 after flattening cards, prioritizing next actions and recapture; does not override unverified accessibility acceptance |
| Performance | final payload versus baseline, lazy agents, polling/console checks | Measured main JS regression +21.4%; agent/delivery loading deferred. Tested polling/focus and page-error assertions passed; long-session/field performance unmeasured |
| Final checks | typecheck, all tests, build, diff/safety review | Passed: 324 tests / 33 files, typecheck and build. Final acceptance-copy rebuild and affected walkthrough passed; diff review complete |

Verification date: 22 September 2026, Chromium 153.0.8010.12, synthetic isolated fixtures. Screenshots: `.ezcoder/screenshots/workspaces/`, `step12/`, `coordination/` and `agent-platform/`. Final assets: main JS 496.58 kB (152.67 gzip), lazy agent 44.71 kB (15.80 gzip), lazy delivery 45.14 kB (14.58 gzip), shared checkbox 7.08 kB (2.70 gzip), CSS 212.95 kB (32.02 gzip). Sampled primary text contrast was 5.02:1 and secondary text 6.43:1; this is not an exhaustive contrast audit. Build time and a 155ms synthetic first-decision observation are not field-speed claims.

Behavioral follow-up: typecheck and 324 tests passed again. A fresh agent → coordination → delivery harness sequence also exited 0 after the requested test-integrity review on 22 September 2026; this is browser-runtime evidence, not an inference from unit tests. Existing agent assertions were preserved; no further code correction was needed. Coordination asserts the original three manual reports, then one explicitly started synthetic agent produces the fourth. Agent acceptance does not accept the milestone; that separate decision is exercised and survives reload. Interruption uses a real graceful fixture-runtime restart with post-listen readiness acknowledgement, persistent workspace/session/history and explicit resume confirmation. Stalled-work age uses the browser clock. No production app code changed in this follow-up.

Landing-review corrections: the portable tracked `test/run-ui-check.mjs` now supplies fixture lifecycle and restart IPC. Agent, coordination and delivery walkthroughs passed again through that harness using an existing Playwright/Chromium installation, without the ignored local wrapper. Typecheck and all 324 tests also passed again. README now names the current engagement control.

Remaining behavioral evidence limits: hard crash/power loss, real elapsed multi-day stalling, live agent/provider execution, scope-change and repeated-failure decision branches, dependency controls and export do not gain new browser evidence from these tests. Details and exact verification commands are in `.ezcoder/redesign-progress.md`.

Implementation and automated verification are finished; manual accessibility/platform acceptance remains open. Real provider entitlement, credentials and live agents were intentionally not exercised. Historical runtime evidence in earlier versions of this document described earlier UIs and is not evidence for this redesign. Durable source/data boundaries above remain authoritative. Generated screenshots and logs stay ignored; no commits or releases are authorized.
