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
that transaction. Enrollment, revocation and session success audits share their writes.
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

Local verification (2026-10-23): 28 terminal PostgreSQL tests, 53 focused API tests and
63 shared-contract tests passed. API type/tenant/stock checks, the 166-route inventory,
69-model RLS policy inventory and migrated-database/schema comparison also passed.

## Remaining P1 MRs, in order

1. **Permissions and exact approvals:** extend the existing auth pipeline; enforce mandatory
   execution checks independently of owner shortcuts. Persist material document approval and
   live authority checks; preserve self-approval rules. Remote assignment authorization and
   exact-target local activation remain separate, atomic actions with D11 checks.
2. **Separate approval from execution:** split held-adjustment acceptance, held-delivery
   acceptance, stocktake approval/completion and stock-bearing import/undo stages. Retain
   remote commercial management and normal reservations; coordinate P6 screens.
3. **Transactional command execution:** integrate receipts with existing business services,
   StockService and AuditService; prove retries/lost responses, digest conflicts, rollback and
   import/worker provenance. No parallel stock writer or user-key-only replay shortcut.
4. **Readiness evidence and integration:** hours acknowledgements, assisted handover, incident
   and card-attempt records, dependency ordering, failure/alternate-path tests and coordinated
   P2/P6 rollout, including the MR 2 attendance port and actual financial-shift binding.
   P5 owns offline business replay and discrepancy settlement.

Production enforcement waits for a usable enrolled desktop client and integrated evidence.
The first MR's declarations do not silently disable browser operations or introduce an owner bypass.
