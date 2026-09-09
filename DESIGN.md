# Decision queue design and evidence

## Coordination workflow (9 September 2026)

**Design read:** same local single-operator app, now with a finite delivery job:
identify the next eligible capability, transfer it, review returned evidence, and
stop at the agreed gate. Reuse Mantine typography, shared rail/cards, native
summary/details, labelled text fields/selects and CopyText fallback. No new visual
system, dependencies, icons or decorative metrics. Today stays compact; scope,
planning and full history live in project details or disclosures.

**Evidence/thesis:** local DeliveryView and ProjectCard are the primary visual
references. MCPJam's actionable-findings task prompt and elizaOS's structured
completion/independent review inspired the exchange, not the visual styling.
Outcome and next action lead; setup and all-history tools are secondary. Reports
are explicitly labelled claims; accepting them is a separate human action.

**Observed:** the legacy delivery walkthrough and new coordination walkthrough pass
in Chromium 148.0.7778.96 with keyboard activation, labelled review/import forms,
clipboard denial, stale-state preservation, a lost response after actual database
save, exact retry, three accepted capabilities, prerequisite resolution, finite
finish, restart/reload persistence and chosen Today focus. No provider POST occurs
in the new flow. Desktop and 320px/200% root-text captures were inspected. The
first pass showed stale model-success/setup messaging during local coordination;
removed that misleading status and clarified the saved-goal next action, rebuilt,
and reran both flows. Existing long-label wrapping and text/control roles are
retained; no horizontal overflow occurred in the tested completion view.

The actual chosen project was also rendered in Today with its saved four-capability
pilot, zero accepted criteria, unresolved live prerequisites and a prepared first
assignment. That screenshot is private and ignored, not synthetic product proof.

**Limits:** reuse is not an accessibility certificate. Screen-reader output,
exhaustive Tab order/target-spacing and all-state contrast, true browser zoom,
non-Chromium browsers, field performance and actual operator time savings remain
unverified. Existing theme contrast samples apply only to those measured roles.
No WCAG/ADA conformance, independently verified project completion or live pilot
acceptance is claimed. Generated screenshots stay under `.ezcoder/screenshots/`.

## Historical Step 12 synthetic browser evidence (8 September 2026)

Added `test/delivery-ui-fixture.ts` and `test/delivery-ui-walkthrough.mjs`. Fixture uses separate temporary source home and appHome, port 4320, an injected ProviderService/auth owner and delayed fake inference returning three whole capabilities. No real authentication, Keychain, provider inference, external client data, live server or live database was used. The older fixture now uses the retained EZBoss legacy attention input instead of forbidden EZ Coder tasks. Its walkthrough follows the new Home project-details link and copies notes from project details, preserving the same editing, failure/retry, focus, polling and clipboard assertions. Both browser walkthroughs passed in the parent run; these expectation changes implement the approved separation of notes from milestones, not suppressed failures.

Production contract read: `/Applications/EZ Coder.app/Contents/Resources/sidecar/skills/evidence-led-ui/references/production-contract.md`. Scope here is native Connections and delivery goal/context/task/completion/history in Chromium 148.0.7778.96. This is partial changed-scope evidence, not WCAG/ADA conformance or overall step completion.

| Changed scope | Runtime evidence / remaining gaps |
|---|---|
| Connections/privacy | Fake connected → disconnected → sign-in pending → success; Claude unavailable; provider response sentinel absent. Real login/expired credentials/account entitlement and exhaustive browser-storage inspection unverified. |
| Goal and exact approval | Connected default OpenAI/gpt-6-astra; explicit Claude choice survives reload; 503 and 409 preserve drafts; Generate disabled before approval; approved fingerprint equals displayed packet. |
| Generation | Whole onboarding, staff review and operational recovery; three pending operation GET reads, no automatic POST. |
| Task copy | Exact preview equals successful clipboard text and denied-clipboard selectable fallback; production shared deliveryAssignment reused unchanged. |
| Completion/history | Response lost after actual fixture save; original retry body/key unchanged; two submissions produce one saved completion. Next heading receives focus; reload retains current; block and reopen preserve history. |
| Keyboard | Native controls activated by focus + Enter, fields typed by keyboard; visible solid 2px focus on copy. Some selects/fills use Playwright helpers; exhaustive Tab order, focus obscuration and assistive-technology output unverified. |
| Reflow/motion | Long descriptions and open disclosures: desktop, 320px, 320px with 200% root text; no document horizontal overflow. Reduced motion, dark theme and forced colors exercised. Parent inspected desktop/dark and enlarged narrow captures, reduced narrow shared-rail/card gutters to 12px to avoid unnecessary word splitting, rebuilt and reran the browser flow successfully. Actual browser zoom, localization/text-spacing and touch remain unverified. |
| Contrast | Sampled copy-control text 15.43:1 in light and 13.58:1 in dark theme. Other states and meaningful borders/focus contrast are not exhaustively measured; no whole-app contrast claim. |
| Performance/support | Chromium only; field CWV, Safari/Firefox and representative screen reader unverified. No project accessibility scanner configured/added. |

Verification: `npx vitest run test/delivery-*.test.ts test/provider-*.test.ts` **83 passing / 7 files**; `npm test` **277 passing / 28 files**; standalone `npm run typecheck` and separate `npm run build` passed. Build preceded browser serving dist. `node test/delivery-ui-walkthrough.mjs` passed; evidence `.ezcoder/screenshots/step12/results.json`, command logs `.ezcoder/screenshots/step12-{focused,tests,typecheck,build,browser}.log`. Final screenshots under `.ezcoder/screenshots/step12/`: `connections-connected.png`, `connections-pending.png`, `context-preview.png`, `delivery-desktop.png`, `delivery-320-100.png`, `delivery-320-200.png`, `delivery-reduced-motion.png`, `completion-next-focus.png`, `history.png`. `failure.png`/`failure.txt` are retained earlier harness-failure evidence, not final success captures. Narrow and blocked-history captures inspected: readable wrapping, native controls and explicit blocked prerequisite; parent inspected final desktop/dark/full-page and enlarged narrow viewport captures and reran after improving gutters. No functional UI fix was required for the verified flow; harness corrections used configured isolated origin and asserted retained blocked current milestone rather than expecting it removed.

## Native delivery UI (step 11, 8 September 2026)

Design read and reuse: inspected the existing MantineProvider theme, App shared Container rail, ProjectsView, ProjectCard four-question editor, CopyText fallback, and existing focus/reduced-motion CSS. Reused bordered md Cards, Stack/Group, native details/summary, labelled Mantine native selects, text inputs and textareas. Parent-provided corpus evidence: evroon/bracket commit 155010777739585ae0fb54e8cd42c1ff44d339d1, frontend/src/components/brackets/brackets.tsx:1–90, asynchronous Button mutation and loading-versus-empty states. No new dependencies, icons, palette or visual system.

Home now leads with Today's project milestone for a visible pinned project, falling back to the current active project. The outcome leads; scope, prerequisites, next milestones and history use disclosures. Saved narrow notes never become a generated milestone. Project detail retains its four-question editor under Project notes and context, with a separately labelled context-only copy. One deliveryAssignment string powers both exact task preview and CopyText, including fixed no-live-client/production/deployment/spending/commit constraints.

Flow: save goal/user/workflow/stage and exact model; explicitly select bounded context categories/documents; collect local-only preview; inspect exact packet/provider/model; approve; explicitly Generate or Replan. Selection/settings changes invalidate the local approval action. All new mutations bootstrap same-origin CSRF and send x-dave-csrf; legacy clients are unchanged. No mutation is automatically replayed. Pending operation polling is GET-only, pauses while hidden and resumes status reads without starting generation. Reload reads latest durable operation. Cancel is explicit. Completion retains its report and idempotency key through network retry, reports user provenance, preserves saved completion if continuation fails, and focuses the milestone heading after success. Conflicts preserve form drafts and show latest returned state; releasing an old completion retry is a separate deliberate action. Queue exhaustion and blocked dependencies are distinct, never fabricated recommendations.

Connections exposes OpenAI storage selection, connect/restore/cancel/disconnect and textual operation/error status. Session storage is an explicit selection, not fallback. Status reads do not restore credentials or make inference requests. Claude requested models remain listed with the server's isolation blocker visible; no login, API-key fallback or boundary relaxation was introduced. Account entitlement and actual authentication remain unverified.

### Step 11 original verification plan (superseded by step 12 evidence above)

| Surface | Code/check evidence | Still required in step 12 |
|---|---|---|
| Goal/context/approval/generation | Exact route shapes inspected; typecheck and production build pass | Synthetic end-to-end preview/approval, changed-context 409, malformed model and connection failures |
| Completion and continuation | Retained report/key, durable reload, separate retry and focus code | Network loss before/after save, reload, blocked/reopen and history interaction |
| Clipboard | Same formatter string and existing selectable fallback | Assert preview equals clipboard, clipboard denial |
| Keyboard/status | Semantic headings, native disclosures, labelled controls, focus styles, status text changes rather than polling counters | Keyboard-only focus order and screen-reader output |
| Reflow/contrast/motion | Existing theme roles and reduced-motion rule reused; long button labels wrap; dark focus uses existing blue-3 | Inspect desktop/320px/200% renders; measure 4.5:1 text and 3:1 meaningful controls in both themes; reduced-motion browser checks |
| Privacy | UI-only work; no live storage, credential, login, model or server restart exercised | Isolated fixtures first; user-assisted live checks belong to later approved steps |

Earlier browser/contrast evidence below applies only to its earlier scope, not these new surfaces. No accessibility-conformance or live integration claim is made.

## Delivery context boundary (approved step 7)

Local collection is opt-in and separate from external-send approval. The packet itself is the preview: category-labelled sources, stable source IDs, explicit user-report provenance, limitations and a SHA-256 fingerprint bound to provider/model and exact packet contents. Later guarded routes must persist and verify approval; no routes, transmission, authentication or generation are added here.

Only selected product Markdown documents are read (8 plus 4 reviewed extra documents), each capped at 64 KiB and excerpted to 4,000 characters after whole-file secret screening. Additional docs require a matching full-file review digest. Package evidence exports dependency names, not scripts/config/URLs. Entrypoints use a fixed bounded candidate list, not bulk traversal. History includes at most 10 saved milestone plans and 50 explicit Dave user completion reports, not imported tasks, legacy notes, raw sessions or model judgments. The complete packet is capped at 64,000 bytes. Rejected content produces generic errors, never file bodies.

The collector reuses the read-only filesystem boundary and evidence-scan size policy, deliberately not the broad legacy documentation sweep (which includes agent/task documents). Canonical containment, regular-file checks, symlink-component rejection and bounded no-follow handle reads protect selected files. Regex screening cannot establish that arbitrary prose contains no private business data: local review and later exact-preview transmission consent remain required. Current manifest support is package.json; entrypoint coverage is explicitly partial. Parent-supplied memsearch bounded-input and supermemory validated-input controls informed this boundary; their task integration and execution mechanisms are not reused.

## Design read
Local, single-operator application with frequent short visits and expensive context switches. The primary job is finding the next evidenced human decision, not surveying activity. Keep the existing Mantine typography, Container `lg` rail, Stack/Group spacing, bordered `md` cards and Tabler icons. No new visual dependency, imagery, theme or decorative dashboard metrics.

First glance: ranked request and honest coverage. Second glance: source text, timestamps, destination and handoff. The distinctive interaction is remembering an evidence revision, not marking an upstream task complete. One queue, three recommendations, explicit remaining count, history and snoozes. Projects become a secondary searchable directory.

## Components and states
- Native buttons and links; details/summary for evidence. Text is escaped by React.
- One shared responsive rail for header, navigation and main content. Content-bearing header has no fixed height. Groups wrap; long text can break anywhere.
- Queue actions use persisted responses without external scans. Pending writes disable competing actions; success is announced through a status region. Focus returns to queue heading after removal; Undo remains available.
- Displayed IDs alone are marked seen. History does not mark queued work seen. The first scan sets a baseline.
- Empty queue means no decisions in checked evidence, never universal health. Coverage distinguishes checked, cached and unavailable.
- Errors preserve useful content and offer Retry. Clipboard denial exposes selectable text. Known-project hash destinations preserve Back/Forward and search; return to a decision restores focus.
- Automatic updates use one coalesced, visible-page schedule, with pause and teardown. A focused decision or summary editor defers incoming content behind Apply update. Snoozes expire from the clock even on cached reads.
- Reused Mantine palette: primary shade 8 and gray-7 secondary text in light mode, gray-4 in dark mode. Default control borders use gray-6. Keyboard focus uses a visible outline; pointer activation does not invent selected state. Native disclosures and a skip link avoid custom keyboard machinery.

## Evidence and boundaries
Existing components are the primary design source. Approved plan contrasts the old scanning-heavy Today/Inbox with nao's durable recommendation identity and cmux's notification-to-context flow. Those are product/structural evidence, not visual assets or runtime guarantees.

## Verification record: 8 September 2026

### Runtime evidence
- `npm test`: **147 passing tests in 18 files**. `npm run typecheck` and `npm run build` pass. No new dependency or test framework was installed.
- Storage: explicit v3-to-v4 preservation, repeated open, injected rollback, failed-backup abort, future-version refusal, and native-backup restore into a separate fixture. Latest restore/inspection took **2ms**. This is a fixture restore time, not a promised production recovery time. App-local migration backup protects the pre-migration committed state; disk loss and off-device recovery remain outside scope.
- Attention: unchanged observations stay suppressed; meaningful revisions surface; failed reads preserve existing evidence; successful absence deactivates it; inactive Undo does not invent current work. Seen state and snoozes survive stored-state round trips. Fifty-project fixture proves the twelve-project cap and explicit over-cap/failed-source coverage.
- External read-only fixture: full tree size, mtime and SHA-256 unchanged after refresh, summary correction, pin, handle, snooze, dismiss, Undo, seen and handoff. Existing read and subprocess spies still enforce denied files and allowed Git operations.
- Browser: installed Playwright **1.60.0**, headless Chromium, synthetic fixture only. `test/ui-walkthrough.mjs` passed keyboard queue → project → copy fallback → Back/Forward → Handled → Undo. It asserted focus restoration, searchable/reloadable destinations, actual empty queue through local fixture actions, error preservation/Retry, 320px and 200% text reflow, reduced-motion/forced-colors modes, minute refresh, pause, hidden-tab silence, return refresh and focused-item deferral. No page JavaScript errors observed.
- Rendered light-mode text contrast: primary button text **5.02:1**, secondary text **8.18:1**. This samples changed semantic roles; it is not a whole-application contrast audit.
- Build output: JS **344.40 KB / 108.56 KB gzip**; CSS **202.31 KB / 29.53 KB gzip**. These are final payload measurements, not before/after performance claims.

### Real-project check
Read the operator's actual discovery sources with **temporary app storage** and no live database migration. Found **23 existing projects**: **12 checked, 11 cached/not-deep-checked, 0 unavailable**, with **0 adapter issues**. The first direct scan took **1,907ms**. A separate real-source API pass verified cached GET reuse plus pinning and summary correction stored only in its temporary database; that multi-refresh pass took **9,431ms**.

There were **0 qualifying human requests** in those real observations. The quiet queue is intentional, not a generated success metric. Real-data handling/snooze could not be exercised on a naturally occurring decision; those actions were verified using synthetic fixture decisions. Real project names, paths and contents were not included in screenshots. The live app database remained unopened during these checks.

### Rendered critique and revision
The first render buried coverage below all recommendations and used low-contrast default secondary text. Moved coverage ahead of the queue, compacted its warning, removed the decorative header shield, strengthened reused palette roles, and recaptured desktop/narrow output. Existing project-card rows now wrap and correction/evidence controls are keyboard reachable.

Rubric (0–2 each): specificity 2; hierarchy 2; composition 2; consistency/flow 2; typography 2; surfaces 2; states 2; responsive 1; accessibility 1; motion 2; authentic content 2; distinctiveness 1. **21/24**, with remaining gaps below, not a conformance certificate.

Synthetic artifacts, ignored from version control, live under `.ezcoder/screenshots/`: `decisions-desktop.png`, `decisions-narrow.png`, `decisions-200-percent.png`, `project-desktop.png`, `project-narrow.png`, `empty-queue.png`. The fixture server was stopped after verification.

### Changed-scope accessibility audit
Scope: Decisions, history/snoozes, directory, project detail, copy, local actions, hash navigation and refresh recovery. Browser evidence covers desktop Chromium with keyboard/pointer and 320 CSS-pixel reflow. This is a partial changed-scope audit, not an assertion about every WCAG criterion or every existing component.

| Area / relevant criteria | Evidence status |
|---|---|
| Keyboard operation and focus order/visibility (2.1.1, 2.1.2, 2.4.3, 2.4.7) | Runtime: primary flow completes, no trap observed, focus restored to queue or destination |
| Skip repeated blocks (2.4.1) | Code: native skip link focuses main without changing project route |
| Labels, structure, status (1.3.1, 2.4.6, 4.1.2, 4.1.3) | Code and browser DOM checks: native controls, labelled search/fallback, headings and live status; assistive-technology output unverified |
| Text contrast (1.4.3) | Runtime: sampled primary/secondary light roles pass; remaining roles, themes and hover/error states unverified |
| Text resize/reflow (1.4.4, 1.4.10) | Runtime: no horizontal overflow at 320px or 200% root text in tested queue; long-path project checked at 320px |
| Pause auto-updates (2.2.2) | Runtime: paused and hidden pages issue no automatic reads; focused decisions stay stable |
| Text errors and recovery (3.3.1, 3.3.3) | Runtime: clipboard denial, failed read and Retry preserve useful context |
| Non-text contrast, target spacing, pointer behavior (1.4.11, 2.5.2, 2.5.8) | Code: stronger borders, native activation, normal-size new controls; exhaustive measurement unverified |
| Reduced motion / forced colors | Runtime: modes exercised without reflow failure; source provides reduced transitions and system focus color |
| Screen-reader, native touch, Safari/Firefox, dark-mode audit, RTL/localization, full text-spacing overrides | Unverified |
| Media alternatives, dragging, authentication, payments | Not applicable to this changed local flow: no media, drag, login or payment surface added |

No project accessibility scanner was installed; none was added. A full criterion-by-criterion audit and representative screen-reader walkthrough remain necessary before any WCAG/ADA claim. No legal-compliance or accessibility-conformance claim is made.

### Product acceptance: measured versus not measured
The synthetic first decision rendered in **258ms** in the final walkthrough. One-click project context and one-action suppression followed by Undo were observed. Rendering latency is **not** evidence that a human chooses correctly within 30 seconds. The 30-second comprehension target and reduced effort during repeated actual daily use remain unmeasured.

### Known ceilings
Deep reads remain capped at twelve projects; no rotating monitoring. Any task/discovery failure conservatively blocks absence-based reconciliation for that scan, not just one task source. Session context still comes from opening prefixes. History is retained, with browser pages of 100 rows; the local snapshot still carries complete history, so server-side history pagination is a future scale boundary. Clipboard filtering removes recognizable code/credential shapes, not arbitrary sensitive prose. No agent execution, editor resume contract, paid service, permanent scanner or off-device backup was introduced.
