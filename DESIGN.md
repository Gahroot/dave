# Decision queue design and evidence

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
