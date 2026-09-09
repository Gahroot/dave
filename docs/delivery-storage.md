# Delivery storage v5

## Scope and rollout boundary

Step 3 adds delivery storage only. No provider calls, authentication changes,
HTTP/UI integration, external project writes, or live database migration were
performed. Claude planning remains fail-closed on the documented isolation issue.
Existing Dave listeners on 4317/4319 were inspected read-only: both run plain Node,
not a source watcher. They were not restarted or stopped.

**Do not restart the live servers onto this code until the planned live rollout.**
`openDb` upgrades older databases automatically. Its existing pre-upgrade native
`VACUUM INTO` backup remains mandatory; an error aborts opening. The additive v5
migration runs in that existing transaction, and a failed migration rolls back
the schema version as well as the new tables. No v4 table, stored user note,
attention outcome, pin or snapshot is rewritten by v5.

## Storage contract

- `delivery_state` holds a per-project optimistic revision, goal/settings,
  context-consent metadata and the selected plan/milestone. No provider credential
  fields exist. Consent metadata is a record only; this layer never transmits data.
- Plan headers have server-created IDs, creation revisions, dates, and frozen
  goal/assumption snapshots. Replanning appends a plan rather than deleting one.
  Compare the plan's goal snapshot with current settings to display stale context.
- Milestones carry whole-capability definitions and dependency positions.
  Dependencies must point backward within the same project/plan, enforced by
  foreign keys and ordered-position checks. Status is constrained to `pending`,
  `blocked`, or `reported-complete`; this is not independent verification.
- Immutable application history events record goal/plan selection, completion,
  blocking and reopening. Completion reports are bounded, quoted user evidence,
  explicitly marked `user-reported`. Other events mean `user-requested`, not proof
  that a model's plan has been delivered. Reopening retains earlier reports.
- Completing a milestone requires the current ID and expected project revision.
  Status, report/event, revision and next eligible selection commit together under
  `BEGIN IMMEDIATE`. Wrong-project references and stale writes fail without changes.
- Completion keys are unique per project, retained without expiry. An exact retry
  returns the latest state with `duplicate: true`, even after restart or replan.
  Reusing a key with changed revision, milestone or report is a conflict. Retry
  never means completing the newly selected milestone.
- Exhaustion saves a separate `delivery_next_plan` intent keyed by completion
  revision. Failure/retry updates that intent, not completion history. Goal changes,
  replan and reopen supersede obsolete intents. The future generation coordinator
  must still enforce context approval and one in-flight request; a stored intent
  alone does **not** authorize an external call.

Public helpers accept bounded structured values and reject unknown fields,
unsupported provider/model pairs, empty acceptance lists, cyclic/unknown dependency
positions and duplicate titles. This is storage validation, not the future strict
external model protocol or semantic milestone-quality validation. All SQL values
use prepared parameters. Reads use a consistent transaction; no transaction spans
network work. Full local history reads are intended for dozens of revisions;
cursor pagination is required before thousands of revisions per project.

## Verification evidence

`npx vitest run test/delivery-storage.test.ts test/storage.test.ts`

RUNTIME: a synthetic v4 database is built from the pre-v5 schema, populated with
manual notes, pins/hidden state, a dismissed attention item and a snapshot. A native
backup is taken, the original is changed, then the backup is restored to another
fixture directory. The restored value, v4 version and integrity are checked before
v5 is applied. Measured restore verification took 1–2 ms in the focused run. This
is a tiny fixture timing, **not** an estimate for the live database.

Tests additionally exercise actual close/reopen persistence, two independent
connections, stale/current-ID conflicts, exact and changed duplicate retries,
blocking/reopening/replanning with retained history, and next-plan failure after
restart. Temporary failure triggers prove rollback both when report insertion
fails and when the final continuation-intent insertion fails. Direct SQL tests
exercise status and foreign-key constraints independently of helper validation.
Existing storage tests are unchanged by step 3.

CODE: pre-upgrade backups live beside Dave storage; they are local rollback
protection, not off-device disaster recovery. Their recovery point is immediately
before migration. No live restore drill, live migration, crash/power-loss test,
off-device backup, or provider execution was performed or claimed.

## Implementation reference

Corpus search `BEGIN IMMEDIATE`, then read
`openworkflowdev/openworkflow`, commit
`fe85ba8a4a5a80a465465019416cee92d79ef653`,
`packages/openworkflow/sqlite/backend.ts:142–185`.

Reuse: acquire the SQLite writer lock before looking up an idempotency key,
return existing work on retry, insert within the same transaction, roll back on
failure. Dave intentionally uses non-expiring completion keys and compares request
hashes: a later UI retry must never silently turn into another completion. Unlike
that workflow backend, these helpers make no runtime/task-execution decisions.
