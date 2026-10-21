# P1 delivery plan and first MR

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

## Remaining P1 MRs, in order

1. **Trusted terminal verification:** enrollment/revocation services and strict signed-command
   parsing, signature/nonce/time checks, tenant/branch and staff/register/till/session binding.
   Provide API device fixtures; integrate with P2 keys and local-attendance evidence.
2. **Permissions and exact approvals:** extend the existing auth pipeline; enforce mandatory
   execution checks independently of owner shortcuts. Persist material document approval and
   live authority checks; preserve self-approval rules. Remote assignment authorization and
   exact-target local activation remain separate, atomic actions with D11 checks.
3. **Separate approval from execution:** split held-adjustment acceptance, held-delivery
   acceptance, stocktake approval/completion and stock-bearing import/undo stages. Retain
   remote commercial management and normal reservations; coordinate P6 screens.
4. **Transactional command execution:** integrate receipts with existing business services,
   StockService and AuditService; prove retries/lost responses, digest conflicts, rollback and
   import/worker provenance. No parallel stock writer or user-key-only replay shortcut.
5. **Readiness evidence and integration:** hours acknowledgements, assisted handover, incident
   and card-attempt records, dependency ordering, failure/alternate-path tests and coordinated
   P2/P6 rollout. P5 owns offline business replay and discrepancy settlement.

Production enforcement waits for a usable enrolled desktop client and integrated evidence.
The first MR's declarations do not silently disable browser operations or introduce an owner bypass.
