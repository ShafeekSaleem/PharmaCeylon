# P1 delivery plan and implementation progress

Baseline: merged P0 amendments through PR #56 (`b317edf`), 2026-10-22.
Epic: [#47](https://github.com/ShafeekSaleem/PharmaCeylon/issues/47).
The approved [contract](POS_V1_CONTRACT.md) and [readiness scenarios](POS_V1_OPERATIONAL_READINESS.md)
remain normative. This document tracks implementation, not a new policy approval round.

## MR 1: action classification and persistence foundation

- `apps/api/src/security/mutation-actions.ts` explicitly maps all 166 inventoried unsafe
  route templates to server-owned action profiles. `classifyMutation` rejects unknown routes
  and methods; it does not infer authority from a route prefix or a client-supplied action.
- `operation-classification.ts` returns effects, local-terminal requirements and mixed-handler
  split markers. Conditional checkout, cash/refund, supplier payment and readiness actions
  require resolved facts; missing facts fail closed. These are internal inputs for future
  verified domain adapters, **not trusted request-body booleans**. Payment adapters must not
  map every noncash method to “bank”: cheque/card/other need explicit evidence/semantics before
  using the bank-record path. Voids resolve the persisted original payment.
- Local cart/count/condition/receipt confirmations can require a local terminal without
  immediately posting a ledger movement. Consumers must check `requiresLocalTerminal` as
  well as the effects. Identity/personalization/attachment profiles preserve existing
  authentication and public-route semantics; they confer no terminal authority.
- `internal-operation-actions.ts` records reviewed service, worker and maintenance entry
  points, including differences between methods in the same service. It is a manual review
  inventory, not a call-graph analyzer or an installed service boundary.
- Three central Prisma models: `OperationalTerminal`, `TerminalEnrollment` and
  `TerminalCommandReceipt`. P2 must reuse these rather than introduce another device registry.

### Persistence invariants

The terminal belongs to one tenant/branch for its lifetime. Moving a device creates a new
branch enrollment under a new branch-scoped terminal identity; never rewrite historical
identity. Enrollment stores a public Ed25519 key as 32 lowercase hex-encoded bytes and a key
identifier, not a private key. Revocation retains the key and its history. Key rotation creates
a new enrollment and must first pass future journal/replacement recovery checks; this schema
does not authorize resetting an offline journal by rotating a key.

Composite foreign keys bind the complete tenant/branch/terminal/enrollment/key chain. A partial
unique index permits one active key per terminal. This **does not** nominate an offline seller:
multiple online terminals per branch are valid; D13 nomination/grant and D11 replacement
clearance are subsequent implementation. Enrollment/retirement workflows must also reject
new use of retired terminals and validate current staff authority.

Final command receipts retain original command, digest, result and actor. Unique identities
are tenant + enrollment + command ID and, when offline, tenant + enrollment + sequence.
Online receipts have no offline sequence. Sequences are positive safe integers and never
reset within an enrollment. Receipts are append-only; enrollment identity and revocation
cannot be overwritten or deleted through ordinary database writes. Follow-up resolution
records must preserve the original receipt, not rewrite what was originally returned.

This table is not an in-flight claim, held support-evidence inbox or grant/snapshot store.
The later executor must validate the signed envelope and canonical digest, acquire authority
and business locks, and write effects, audit and final receipt in one transaction. On unique
conflict it must fetch the original scoped receipt and compare the full identity/digest before
replaying the result; the database constraint alone does not implement exactly-once execution.
Historical storage after revocation is intentionally possible for reconciliation; it does not
authorize new operations with a revoked key. Existing user-scoped idempotency stays unchanged
until command integration is implemented. No register/till/session schema is invented here;
their trusted binding and persistence are part of MR 2/P2 integration.

The migration is additive, does not backfill or rewrite stock, and stages disabled tenant RLS
policies consistently with the existing inventory. Migration-only checks/triggers and the
active-key partial index must be preserved by subsequent migrations.

### Validation and rollout boundary

Unit tests compare the explicit registry with the route inventory and exercise remote
management, reservations, physical execution, mixed handlers, conditional effects and unknown
actions. The existing route scanner independently compares inventory against controllers.
Database tests apply the real migration history and exercise scope constraints, key rotation,
immutable history, concurrent command uniqueness, sequence uniqueness and receipt/audit
transaction rollback. CI runs both suites and the existing stock/tenant checks.

**MR 1 does not install guards, endpoints or service enforcement.** Existing checkout and web
operations behave as before. No claim of verified attendance, signature validation, business
exactly-once execution or completed P1 acceptance follows from merging this foundation.

## MR 2: terminal trust services and signed challenges

Builds on merged [MR #57](https://github.com/ShafeekSaleem/PharmaCeylon/pull/57).
`TerminalTrustService` supplies backend counter creation, enrollment, staff authorization,
command preparation/verification, session deauthorization, key revocation and terminal retirement.
`TerminalsModule` exports these services; it exposes no HTTP endpoints and does not change
existing checkout or browser behavior.

### Trusted identity and protocol

- `TerminalCounter` supplies server-generated register and drawer identities, scoped to one
  branch. Only one nonretired terminal can occupy a counter. Counter bindings are immutable;
  legacy unbound registry rows cannot pass verification.
- Enrollment uses a server-created two-minute challenge, candidate Ed25519 key possession
  and independent local-attendance verification. Subsequent signatures use the pinned public
  key in the central enrollment, never a public key supplied with an operational command.
- `TerminalStaffSession` binds the authenticated staff member and token version to the exact
  enrollment/register/drawer. Live account, membership, branch assignment and permission
  checks read the database rather than cached role claims. Identity-session authorization is
  available to branch staff; each operation separately requires its server-selected permission.
- `TerminalChallenge` retains the exact server-issued payload digest, actor, purpose, expiry
  and single-use nonce hash. Runtime parsing rejects unknown fields, malformed signatures,
  coercion, excessive payloads and altered identity/body/evidence. Shared enrollment/session
  types are additive; their two-minute challenges are unrelated to the 24-hour offline grant.
- Registry administration uses the existing `tenant.management` permission. This grants no
  D13 offline nomination or delegation. Retirement releases a counter for online replacement;
  it does not establish D11 journal recovery or old offline-grant expiry/disablement.

The counter/drawer records hold no cash balance. Staff authorization is a terminal identity
binding, **not a posted financial shift**. P2/P4 must bind actual shift opening, closing and
handover records before operational checkout uses these identities.

### Transaction and P2 integration boundary

Every service call takes the caller's Prisma transaction. Verification locks the enrollment
against revocation/session closure, rechecks current session state and consumes the nonce in
that transaction. Command/session flows re-read live actor authority after acquiring the
enrollment lock, so a logout or permission removal committed during the wait cannot authorize
the operation. Session deauthorization, revocation and retirement use the same ordering.
Callers use PostgreSQL's default READ COMMITTED isolation for these fresh post-lock reads;
a repeatable snapshot must not be substituted for current authorization.
Enrollment, revocation and session success audits share their writes.
Business adapters must pass strict server-owned operation/permission/body parsers; request
fields must never select those adapters.

The future executor must verify and execute effects/audit/final receipt in the **same**
transaction. A failure rolls back nonce consumption, allowing retry. This MR does not yet
implement business-result replay: the executor must check a scoped original receipt and
matching digest before treating a consumed challenge as a retry. Exact approval, clinical,
hours and business-limit checks also remain mandatory executor work.

`LocalAttendanceVerifier` is an integration port whose production implementation currently
denies every proof. P2 must supply independently authenticated installation/current local
session evidence bound to purpose, enrollment/key, staff, counter and payload digest;
remote or unknown attendance must fail, including for owners. A key signature alone does
not prove local use. The permissive proof authority exists only in the database test fixture;
there is no production mock/configuration bypass. Windows attendance and client enrollment
are not claimed complete by merging this backend MR.

Validation uses real Ed25519 fixtures and PostgreSQL migrations, including wrong bindings,
revocation races, concurrent nonce consumption, live permission changes, audit/downstream
rollback and online replacement. CI runs both terminal database suites. Tenant policies
remain staged/disabled consistently with the existing RLS inventory; stock is unchanged.

Local verification (2026-10-23): 35 terminal PostgreSQL tests, 53 focused API tests and
63 shared-contract tests passed. API type/tenant/stock checks, the 166-route inventory,
69-model RLS policy inventory and migrated-database/schema comparison also passed.
Review regression tests confirm an actual PostgreSQL enrollment lock wait before changing
authority on another connection. Token changes across command/session/lifecycle methods and
custom-permission removal reject without consuming a challenge, creating a binding or emitting
a success audit. The original four command/session token cases and permission-removal case
were reproduced failing before the fix.

## MR 3: transactional permissions and exact material approvals

Builds on merged [MR #58](https://github.com/ShafeekSaleem/PharmaCeylon/pull/58).
`OperationalAuthorizationModule` exports `OperationAuthorizationService` and
`ManagementApprovalsService`, reusing `AccessService` and `TerminalTrustService` rather
than adding another HTTP guard. Existing JWT/CSRF/branch/permission guards retain their order.

### Exact approvals

The initial document adapters read and lock real purchase orders, source-branch transfers and
supplier returns. They support `purchase_order.receive`, `transfer.ship` and
`goods_return.complete`, with the existing approval/execution permissions. Customer refunds
remain a separate POS workflow; legacy customer returns cannot use supplier completion.

1. `preview` returns the server-derived material identity/content under the document lock.
2. `issue` requires that displayed revision/digest, the current approval permission and existing
   self-approval settings. Its caller-generated approval UUID is a retry identity, not authority.
   Reusing it with changed document/action/reason/expiry/approver fails. Authorization and its
   success audit commit together. It does not change domain status, reservations or stock.
3. `requireForExecution` locks the current domain document and immutable evidence, then checks
   exact tenant/branch/action/document/requester/version/digest, revocation, workflow expiry and
   the approver's current account/membership/branch permission/self-approval settings. A completed,
   cancelled or ineligible document cannot execute merely because evidence exists.

No mandatory approval TTL or additional approver/executor separation is introduced. Logging
out the approver does not erase their commercial approval: current rights are revalidated
independently of the old login token. Executing staff still need a current authenticated token.
Revocation retains the original approval and material snapshot. The service returns requester
and approver attribution alongside the separately authenticated executor; the future business
executor must persist all three with terminal/session/command identifiers.

Database triggers maintain `approvalVersion` and `metadataVersion` on these three document
types, including legacy/internal writes. Header or line material changes advance the approval
revision, even when a value is later restored. Notes advance only metadata; status and normal
partial-receipt counters do not restate approved material. Line edits serialize against the
parent document lock. New evidence retains exact material JSON/digest and cannot be rewritten
or deleted through ordinary writes. Existing documents receive revision counters; **no old
approval evidence is fabricated or backfilled**. Existing RLS policies remain staged/disabled.

### Transactional operation boundary

Server-owned descriptors select the registered route, existing permission, strict body parser,
resolved product/payment facts and any exact approval requirement. They are code adapters,
never deserialized request fields. The boundary permits authorized online management and
ordinary reservations without terminal keys; bank records additionally require evidence.
Local/mixed effects require the signed command and independent attendance before mandatory
clinical and hours checks. Conditional facts and live authority are rechecked after lock waits;
owner grants cannot skip these requirements.
After mandatory evidence providers finish, the boundary revalidates the same pinned
approval/action/document again as its final asynchronous check. Approval expiry and live
approver rights can change while a provider waits even with document/evidence locks held.

The production clinical, hours and bank evidence ports fail closed until their domain providers
are installed. These ports accept exact command/context records, not caller-supplied “verified”
booleans. Test providers/mocks are confined to tests. Domain adapters must hold their business
locks and enforce current quantities, remaining receipts/refund limits, policy thresholds and
receipt idempotency. Do not turn an approval-optional workflow into a mandatory approval step.

All calls use the caller's READ COMMITTED transaction. Authorization, business effects, success
audit and final command receipt must share it; let denials/errors escape so consumed nonces
roll back. The boundary does not itself execute business callbacks or claim final-result replay.

**Rollout:** this MR exposes no new HTTP endpoints and does not redirect existing browser or
desktop workflows. Legacy approval handlers are not wired to this evidence yet; that migration
belongs with handler separation and transactional execution. Mixed adjustment/delivery/stocktake
and stock-bearing import adapters, POS refund approvals, real clinical/hours/bank evidence,
D13 delegation/activation with D11 clearance, P2 attendance/P4 shifts and P6 UI integration remain
explicit rollout work. Generic registry permissions confer none of that authority.

Validation (2026-10-23): all eight PostgreSQL integration suites passed (131 tests),
including legacy purchasing/transfer/return workflows and last-unit stock concurrency.
The authorization, authentication, access and classification checks passed (69 focused API
tests in total). API type/tenant/stock checks, the 166-route inventory, 70-model staged RLS
inventory and migrated-schema comparison passed. CI now runs the complete database suite.
Review regression coverage adds real enrolled Ed25519 commands paused inside a test evidence
provider. Expiry or approver-permission removal during that pause rejects authorization and
rolls back the consumed nonce; downstream document changes and success audit do not commit.
An unchanged approval succeeds through the same pause, with one nonce consumption/audit.
Review verification (2026-10-24): 57 P1 PostgreSQL tests, 71 focused API tests and
API type/tenant/stock checks passed. Both new unit regressions failed before the fix.

## MR 4a: separate stocktake approval and posting

Stocktake approval now records exact `stocktake.post` management evidence and changes
status to `approved` only. Posting applies stock adjustments/quarantine through the existing
StockService, then completes the count. Both transitions commit their success audit in their
own database transaction. The screen presents separate approval and posting confirmations;
it pins the displayed material revision/digest and a stable approval retry ID.

Database triggers advance material revisions for count/condition/reason/resolution, baseline
and counter-evidence changes, including internal writers and change-then-revert edits.
Material changes clear the active approval and reopen approved counts for review. Notes
advance metadata only. Completed/posted material is immutable. Every counter participates
in the existing self-approval check; posting revalidates the approver's current branch rights
independently from the executor. There is no new two-person rule or mandatory TTL.

Posting locks the document and counted batches before its final approval/authority check.
Repeated posting cannot produce a second stock effect; stock, quarantine, posting records,
completion and success audit roll back together. Legacy approved counts have no fabricated
exact evidence: review and approve them again before posting. Already posted/completed
counts retain their history. The schema change is additive and creates no new tenant model.

This is the stocktake portion of the mixed-handler split. Held adjustments/deliveries and
stock-bearing import/undo remain mixed and retain local-required classifications. The
production terminal/attendance boundary still waits for P2 and the coordinated P1 executor;
this MR does not claim signed command receipts, full P1 acceptance or offline replay.
API/web must deploy together because approval now requires the displayed revision/digest
and no longer posts inventory. Existing clients must use the separate posting action.
The daily-work queue treats authorized counts as posting work; it does not apply a counter's
self-approval block to execution of another person's valid approval. Legacy approvals still
appear as review work until fresh exact evidence exists.

Validation (2026-10-25): 75 API unit suites / 888 tests, 63 shared-contract tests,
19 web suites / 172 tests and all eight PostgreSQL integration suites / 144 tests passed.
The database suite includes an actual batch-lock wait with authority removal, identical
approval/post retries, revoked approval, material change/revert, note preservation, all-counter
self-approval, audit rollback and dashboard action routing. API and web production builds,
API/web/integration TypeScript checks, tenant/stock scanners and the unchanged 166-route
inventory passed. All 70 tenant-model RLS policies remain staged/disabled; the migrated
PostgreSQL schema matches Prisma. Database verification used a disposable PostgreSQL 16
instance; remote CI/publishing has not run for this change.

## MR 4b: held-adjustment and held-delivery approval/posting split

Both `accept` routes now record exact ManagementApproval evidence and leave stock unchanged
in a new `approved` state. Separate `post` routes execute through the existing InventoryService,
PurchasingService and StockService in caller-owned READ COMMITTED transactions. Document state,
stock/quarantine, reference/receipt, supplier invoice and success audit commit together. Repeats
return the saved posting link; signed command receipts/replay remain later executor work.

Held deliveries retain original input and a separate correction draft. Saving corrections requires
the displayed material/PO digest; approval confirms the fresh returned preview. Approved payload,
PO material revision and exception choices are revalidated at execution. A receiving-only operator
can post the approver's scoped delivery without acquiring `purchasing.approve`. Both workflows
recheck live approver/executor authority after actual stock-lock waits. Current self-approval rules
are retained; the requester may execute someone else's valid approval. Revoked/obsolete approvals
can be explicitly replaced. Notes preserve approvals; changed-and-restored material does not.

Approved deliveries block alternate receipt routes. PO-first locking serializes held creation,
approval, receipt posting, revocation and closed-order cleanup. A failed stock/audit operation
leaves the approved request intact. Existing posted history is retained without fabricated evidence.
The screens, notifications and daily-work queue distinguish approval from posting. API/web must
deploy together because `accept` now requires the preview and stable approval UUID.

Posting requires the approval ID displayed to the operator. A replaced approval invalidates a
stale posting confirmation, even if the old evidence would otherwise remain valid. Requester
notifications are sent after commit and distinguish authorization from actual stock posting.

Validation (2026-10-26): the complete API unit suite passed 890 tests, the complete web suite
passed 178 tests, and all nine PostgreSQL suites passed 167 tests before the final posting-ID
checks. The final four affected PostgreSQL suites passed 89 tests (including stale posting IDs
and the added receiving-queue regression), and the four UI regressions and API/web types passed.
The API production build passed. Migrated schema comparison has no differences; the 169-route
inventory, tenant/stock checks and 70 staged/disabled RLS policy inventory passed. The local web
build hit the Windows cross-drive dependency-junction resolver limitation; CI validates its build
from a clean installation.

The registry now covers 169 routes: three additions for held adjustment posting, held delivery
correction preparation and held delivery posting. Approval is management; physical posting is local
in policy metadata. Production terminal/attendance enforcement still awaits the coordinated P1/P2/P6
cutover. Approval-optional direct adjustments/receipts retain existing policies. No offline allocation,
new mandatory TTL or additional approver/executor separation is introduced.

## MR 5: signed command execution with original-result receipts

Builds on MR 1–4c. `TerminalCommandExecutor` (`apps/api/src/terminal-commands/`) is the
executor that MR 1–3 deferred. Two endpoints expose it: `POST /terminal-commands/prepare` and
`POST /terminal-commands/execute`. The wire contract the P2 client implements is the
"Signed terminal commands" section of [API_CONTRACT.md](API_CONTRACT.md), with shared types in
`packages/shared/src/terminal-command-execution.ts`.

### What executes

A closed, frozen `SignedOperations` registry wires the five already-split physical routes:

- stocktake post;
- held adjustment post;
- held delivery post;
- import stock post;
- import undo-stock.

A request selects an adapter only through the exact signed `operation` string. Each adapter
supplies the descriptor that `OperationAuthorizationService` consumes (permission, strict body
parser, exact approval action and document). It then calls a new in-transaction domain core
(`postInTransaction` / `undoInTransaction`). The browser routes now wrap the same cores, so
each operation still has one implementation, and StockService remains the only stock writer
(`check:stock-writes` is unchanged). Signed posts pin the approval ID the command carried.
Each domain success audit records the verified command provenance: command ID, digest,
terminal, enrollment, key, register, till, work session and attendance ID. It also keeps the
existing requester, approver and executor attribution.

### Transaction and replay

One READ COMMITTED transaction per `execute`:

1. Lock the enrollment.
2. Report a revoked or retired device as `TERMINAL_REVOKED`.
3. Look up the receipt scoped by tenant + enrollment + command ID.
4. Then do one of the following:
   - **Replay.** Requires the same staff user, a valid signature with the pinned key and the
     identical digest, operation and identity. Otherwise the result is `REPLAY_CONFLICT`
     (409). Replay writes nothing.
   - **Authorize and execute.** Runs the existing boundary (session, live permission,
     challenge, signature, attendance, exact approval, evidence ports, final rechecks), then
     the domain core, then the `terminal.command_executed` audit, then the receipt insert.

Any failure rolls back business effects, both audits, the receipt and nonce consumption. The
same signed envelope can therefore be retried within its challenge window.

Identical concurrent retries serialize on the enrollment lock and replay the committed receipt.
A defensive unique-violation path replays the original too and never re-executes. Online
receipts have `offline_sequence` NULL. Notifications move to explicit post-commit helpers.

### Rollout boundary

Nothing is activated:

- The production `LocalAttendanceVerifier` still denies every proof, and the hours evidence
  port still denies every local command. In production, `execute` therefore fails closed with
  `LOCAL_ATTENDANCE_UNAVAILABLE` (a test proves both denials).
- Browser routes keep their current behaviour, and W1 rollout state is not consulted yet.
- P2 still owns enrollment/session HTTP endpoints, the attendance provider, PIN sign-in and the
  desktop client. This MR adds none of them.
- No schema migration: the MR 1 `terminal_command_receipt` table already has every field the
  receipt needs.

The registry gains two routes (183 in the inventory):

- `prepare` is classified `identity`: it issues a challenge and has no effect.
- `execute` is classified `stock`: every v1 operation is physical stock.

### Validation

Validation (2026-10-28, local PostgreSQL 18):

- **New `terminal-execution.int-spec.ts` (19 tests):**
  - a lost response replays an identical receipt with one stock effect, one domain audit and one
    execution audit;
  - three concurrent identical executes produce one receipt and one effect;
  - an altered committed command is `REPLAY_CONFLICT`, and an altered prepared command is
    `CHALLENGE_INVALID`;
  - owner calls are rejected for another tenant, a wrong branch header, another enrollment's
    identity, another device's signature and unverified attendance;
  - a revoked device is rejected for both execution and replay, and another staff member's
    replay is refused;
  - injected business, domain-audit, execution-audit and receipt (database trigger) failures
    each leave no stock, audit, receipt or consumed nonce, and the same envelope then succeeds
    once;
  - held write-off, held delivery, import posting (including `already_applied`) and legacy
    import undo all run end to end with replay;
  - the production providers deny the command.
- **Full suites:**
  - all 15 PostgreSQL suites (244 tests) passed, including stock last-unit concurrency, held,
    stocktake and import regressions;
  - API unit tests: 1046 of 1047 passed in the full run. `security.guards.spec.ts` (unchanged)
    exceeded its timeout on a memory-starved machine; it passes 14/14 on its own;
  - `npm run lint -w api` (types, tenant and stock-write checks) and the 183-route mutation
    inventory passed. CI runs everything again.

## Remaining P1 MRs, in order

### MR 4c: product-import stock staging and separate posting

`POST /products/import/stage` is the remote catalog/staging path. It writes products and a
durable `ProductImport.stagedStock` draft, never batches, ledger, running stock or reservations.
The existing `/confirm` keeps legacy not-live imports working, but independently stages stock
when the branch is live, including checkout fallback. Worker stock transactions share-lock the
branch and refuse legacy posting after go-live. The web uses `/stage` for live/fallback or unknown
rollout state and `/confirm` only for known not-live branches.

The draft has a database-maintained material version. Bulk replacement requires the displayed
version and cost access; internal material writes and change-then-revert advance the version too.
The first posting freezes all material and its staging actor. The counter posts the whole draft
or a category at a time, binding that version. Each chunk creates batches and calls StockService
once; saved row/batch identities prevent duplicate receipt on retries and concurrent requests.
Stock effects, posted markers/counters and actor audit share one transaction. Posted chunks retain
their original identities; corrections use ordinary local stock adjustments, not draft replacement
or deletion. Read/post responses redact saved cost without `costs.view`; stock-only executors
can post the server-held values without seeing costs.

Management `/undo` refuses imports with posted stock. `/undo-stock` retains guarded cancellation
of untouched legacy imports and is classified physical. Both paths revalidate live import permission
after document/product/batch locks and again after cascading deletes, so a permission revocation
during a child-row wait rolls back deletion, stock, status and audit. StockService now owns the
legacy ledger deletion too; no import-service stock-write exemption remains. History suppresses
physical web undo for live/fallback branches and requests switching branches for a legacy import
belonging elsewhere. API and web must deploy together for the legacy undo route change.

This is a handler/data split, like MR 4a/4b, not the signed terminal executor. New physical routes
have local policy classifications; production proof/attendance enforcement still waits for the
coordinated P1/P2 cutover. P2 remains outside this change. W5/W8 own the full draft editor, counter
execution screens and onboarding handoff. The additive migration preserves existing import/stock
history; no historical command receipt or terminal executor identity is fabricated.

Validation: PostgreSQL regressions cover staging, categories, retry/concurrency, rollback,
scope, cost redaction, material history, legacy behavior and real cascade lock-wait permission
removal in both undo modes. Focused API import/policy tests and rollout-aware web caller tests
cover strict row validation and management-versus-physical route selection.

MR #61 review fixes (2026-10-27): supplier-price choices are hydrated from the current held
delivery and reset across order/receipt lifecycles. Corrections send the choice only when explicitly
changed. Approvers can confirm the current saved document without rebuilding its form, including
when costs are redacted. Corrections retain omitted supplier notes, exact costs and exception choices
on the server; unchanged costs are not rounded through the form. Confirmation displays the saved
document and explains that unsaved form edits are excluded. Regression validation passed 56 real
PostgreSQL tests across held approvals and purchasing, the complete 181-test web suite before the
final opt-out case, all four final modal regression tests, API/web type checks and tenant/stock checks.

MR #60 review fixes (2026-10-26): persisted approval material uses deterministic document-sized
encoding without incoming-command size limits. Existing digest encoding is preserved, and signed
terminal commands retain their bounds. PostgreSQL regressions cover list/detail, issuance and
execution validation for 500-batch custom and 750-batch full counts. Approved counts offer explicit
fresh approval even with an existing evidence ID, allowing recovery after approver rights change;
prior evidence is retained and current self-approval rules still apply. Review validation passed:
50 PostgreSQL workflow/approval tests, 50 focused API tests, 2 UI recovery tests, API/web types,
tenant/stock scanners and the 166-route inventory.

1. **Separate approval from execution:** finish stock-bearing import/undo stages.
   Stocktakes are split in MR 4a and held requests in MR 4b. Retain
   remote commercial management and normal reservations; coordinate P6 screens.
2. **Transactional command execution:** done for the five split physical operations (MR 5).
   Still open:
   - further adapters as more handlers are split (transfers, returns, receipts, sales/refunds,
     cash);
   - persisted provenance for import/background workers and maintenance writers;
   - aligning the error body with the shared `TerminalApiError` (`correlationId`/`retryable`);
   - restricting browser routes to terminals once W1 rollout and P2 are ready.
3. **Readiness evidence and integration:** hours acknowledgements, assisted handover, incident
   and card-attempt records, dependency ordering, failure/alternate-path tests and coordinated
   P2/P6 rollout, including attendance/mandatory-evidence providers, D13 authorizations/delegation
   and local activation with D11 clearance, and actual financial-shift binding.
   P5 owns offline business replay and discrepancy settlement.

Production enforcement waits for a usable enrolled desktop client and integrated evidence.
The first MR's declarations do not silently disable browser operations or introduce an owner bypass.
