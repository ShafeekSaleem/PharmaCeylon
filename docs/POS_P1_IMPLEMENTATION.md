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

## Remaining P1 MRs, in order

MR #60 review fixes (2026-10-26): persisted approval material uses deterministic document-sized
encoding without incoming-command size limits. Existing digest encoding is preserved, and signed
terminal commands retain their bounds. PostgreSQL regressions cover list/detail, issuance and
execution validation for 500-batch custom and 750-batch full counts. Approved counts offer explicit
fresh approval even with an existing evidence ID, allowing recovery after approver rights change;
prior evidence is retained and current self-approval rules still apply. Review validation passed:
50 PostgreSQL workflow/approval tests, 50 focused API tests, 2 UI recovery tests, API/web types,
tenant/stock scanners and the 166-route inventory.

1. **Separate approval from execution:** finish held-adjustment acceptance, held-delivery
   acceptance and stock-bearing import/undo stages. Stocktake approval/posting is split in MR 4a. Retain
   remote commercial management and normal reservations; coordinate P6 screens.
2. **Transactional command execution:** integrate exact approvals and receipts with existing business services,
   StockService and AuditService; prove retries/lost responses, digest conflicts, rollback and
   import/worker provenance. No parallel stock writer or user-key-only replay shortcut.
3. **Readiness evidence and integration:** hours acknowledgements, assisted handover, incident
   and card-attempt records, dependency ordering, failure/alternate-path tests and coordinated
   P2/P6 rollout, including attendance/mandatory-evidence providers, D13 authorizations/delegation
   and local activation with D11 clearance, and actual financial-shift binding.
   P5 owns offline business replay and discrepancy settlement.

Production enforcement waits for a usable enrolled desktop client and integrated evidence.
The first MR's declarations do not silently disable browser operations or introduce an owner bypass.
