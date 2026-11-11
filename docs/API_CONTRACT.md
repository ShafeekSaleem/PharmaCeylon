# PharmaCeylon API contract (pilot, v1)

## Product-import stock staging (P1 / D-W2)

- `POST /products/import/stage`: same multipart upload, mapping/category decisions and
  Idempotency-Key as `/confirm`, with no physical stock effect. `/confirm` retains legacy
  not-live behavior but auto-stages at desktop-live branches, including checkout fallback. Its
  classification is resolved, not mixed: physical only for that legacy not-live stock posting.
- `GET /products/import/:importId/stock`: selected-branch draft, version, rows, staging actor
  and first posting time. Requires current `products.import`; saved `costPrice` is null without
  `costs.view`. Row `postedBatchId` is the durable posting result.
- `POST /products/import/:importId/stock/replace`: `{ version, rows }`, at most 20,000 rows.
  Requires `products.import` and `costs.view`. Large drafts may send that JSON document as a
  multipart `file` (20 MB limit). Each row has `rowNumber`, `productId`, `name`, `categoryName`
  (string or null), positive integer `qty`, nonnegative numeric `costPrice`/`sellingPrice`,
  `batchNo`, and `expiryDate` (midnight UTC ISO string or null). Unknown fields and client
  posting identities are rejected. Replacement is allowed only before any row is posted.
- `POST /products/import/:importId/stock/post`: `{ version, categoryName? }`; omit the category
  to post all remaining rows, or send null for the uncategorized group. Physical execution
  requires `products.import` at the selected branch. It uses saved costs, preserving redaction
  for cost-hidden executors. Repeating a selection/version returns its saved batch identities
  without additional stock or audit. Any failure rolls back the entire selected chunk.
- `POST /products/import/:importId/undo` is management-only and refuses posted stock.
  `POST /products/import/:importId/undo-stock` is the physical legacy cancellation path, with
  the import's branch selected. Prior trade/reservations block it. Posted D-W2 drafts retain
  their ledger and require ordinary counter adjustments for corrections.

The history API returns `stockStaged`, pending `unitsStaged` and `stockUndo`. It disables web
stock undo at live/fallback branches and when the selected branch differs. Import job results
describe the original import; the draft/history endpoints supply current posting state.
API and web deploy together for the legacy undo route change. Both physical import routes can
also run as signed terminal commands with original-result receipts (see "Signed terminal
commands" below).

**Job authority (P1 MR 6).** `/confirm` and `/stage` record who started the job: the user, their
access-token version, the selected branch (none = any branch, catalog only) and
`products.import`. The background worker rechecks exactly that before every write transaction.
If the starter's permission was removed, a role or password changed, they signed out
everywhere, or the branch/account was deactivated, the job stops: `GET /products/import/jobs/:id`
reports `status: "failed"` with an explanatory `error`, products/stock committed by earlier
chunks are kept, and a `products.import_stopped` audit event is written. Start a new import for
the rest. `POST /products/nmra-import/confirm` behaves the same way for `nmra.import`
(`products.nmra_import_started` / `products.nmra_import_stopped`). Independent attendance, full desktop screens and enforcement on the browser
routes remain the later coordinated P1/P2/P6 cutover.

Single reference for the web team. The machine-readable contract is the **OpenAPI document** served by the API.

The desktop/offline v1 contract and revised D10 remote-management/local-execution boundary are defined in
[POS_V1_CONTRACT.md](POS_V1_CONTRACT.md) with the
[operational mutation inventory](POS_OPERATIONAL_MUTATIONS.md). P0 adds shared contracts
and fixtures; existing endpoints below retain their current behaviour until P1–P6 implement them.
The approved [operational-readiness amendment](POS_V1_OPERATIONAL_READINESS.md) adds revised D8
business-hours acknowledgement, D13 remote authorization/local activation, payment/incident evidence
and recovery gates. These describe future interfaces, not live API endpoints.

## Base URL and prefix

- Local API default: `http://localhost:3001`
- All REST routes are under **`/api/v1`** (global prefix).

## OpenAPI / Swagger

- **Swagger UI**: `{API_ORIGIN}/api/v1/docs`  
  Example: `http://localhost:3001/api/v1/docs`
- Disable in a given process with `OPENAPI_ENABLED=false` (see `apps/api/.env.example`).

Controllers are annotated incrementally; sales routes include the richest operation docs. Regenerate or extend decorators on other modules as endpoints stabilize.

## Auth and branch context

- **`POST /api/v1/auth/login`**: JSON body `{ "email", "password" }` only. `AppUser.email` is **globally unique**; the server loads the user by email and derives `tenantId` from that row (subdomain-based routing can be added later without changing this contract).
- Browser flow uses **httpOnly cookies** and **CSRF** (`X-CSRF-Token` echoing the `pc_csrf` cookie). See existing web `auth-client` / API security modules.
- Branch scoping uses **`x-branch-id`** on requests that require a branch (same as today).

### Password recovery

Three `@Public()`, individually throttled endpoints. No branch header, no tenant context — the requester is signed out and `AppUser.email` is globally unique, so the emailed token is the only credential (same shape as staff invitations).

| Endpoint                                   | Throttle | Notes                                                              |
| ------------------------------------------ | -------- | ------------------------------------------------------------------ |
| `POST /api/v1/auth/password-reset/request` | 5 / min  | Body `{ "email" }`. Always `200 { ok: true }`.                      |
| `GET /api/v1/auth/password-reset/:token`   | 20 / min | Pre-flight check. Returns `{ email (masked), expiresAt }` or `400`. |
| `POST /api/v1/auth/password-reset/confirm` | 10 / min | Body `{ "token", "newPassword" }`.                                  |

**Semantics**

- **The request endpoint never reveals whether an account exists.** Unknown addresses and suspended accounts return the same `{ ok: true }` and send nothing. Clients must not word their UI in a way that reintroduces the leak.
- Tokens are stored as a **SHA-256 hash**; the raw value exists only in the email. Single-use, 30-minute TTL, and issuing a new one retires any outstanding tokens for that user.
- Confirm applies the tenant's `passwordMinLength` / `passwordRequireNumberOrSymbol` policy, clears `failedLoginAttempts` / `lockedUntil`, then **hard-revokes every session** (`tokenVersion` bump) — the user is signed out on all devices and must sign in again.
- Every failure mode (expired, spent, forged) returns one identical `400`.

## Idempotency (money / stock mutations)

Send optional header **`Idempotency-Key`** (max 128 characters, trimmed). Keys are scoped per **`tenantId` + `userId` + operation scope** so two users do not collide.

| Operation        | Scope (internal)   | HTTP                                              |
| ---------------- | ------------------ | ------------------------------------------------- |
| POS checkout     | `checkout`         | `POST /api/v1/sales/checkout`                     |
| Goods receipt    | `receive_goods`    | `POST /api/v1/purchasing/purchase-orders/receive` |
| Transfer ship    | `transfer_ship`    | `POST /api/v1/transfers/:id/ship`                 |
| Transfer receive | `transfer_receive` | `POST /api/v1/transfers/:id/receive`              |
| Prepared refund  | `sale_refund_execute` | `POST /api/v1/sales/refund-requests/:id/execute` |
| Product import   | `product_import`   | `POST /api/v1/products/import/confirm`            |
| Supplier payment | `supplier_payment` | `POST /api/v1/purchasing/payments`                |
| Write-off request | `held_adjustment_request` | `POST /api/v1/inventory/adjustment-requests` |
| Stock adjustment | `stock_adjustment` | `POST /api/v1/inventory/adjustments`              |
| Refused-entry decision | `offline_journal_settlement_prepare` | `POST /api/v1/offline-journal-reviews/:id/settlements` |

**Semantics**

- First request with a key performs the mutation and records the key → resource id.
- Retries with the **same** key return the **same** resource (replay).
- Reusing a key for a **different** logical operation (e.g. different PO on receive, different transfer id on ship/receive) returns **400** with a clear message—do not silently post twice.
- `checkout` keys can be sealed: `POST /sales/checkout/resolve` records scope `checkout_sealed`
  for the seller's key once nothing landed under it, and checkout then refuses that key with 409
  `CHECKOUT_SEALED` ("Desktop enrollment and staff sessions", "Unconfirmed sales").
- `stock_adjustment` keeps the first request's body with the key (`idempotency_record.request_body`) and replays only an identical body at the same branch; any other body is the 400. `held_adjustment_request` compares against the held adjustment's saved payload. `offline_journal_settlement_prepare` keeps `{ reviewId, decision, reason }` and replays the settlement only for the same entry, decision and reason.

## Private supplier-payment evidence (P1)

These online endpoints require `suppliers.pay`, a selected branch (`x-branch-id`) and current
branch authority. They add an explicit evidence-backed recording path; the existing ledger
and supplier-page payment/void endpoints keep their existing behavior until a coordinated
client cutover. Actual branch cash remains a local physical action. This slice does not
activate terminal or attendance enforcement.

- `POST /api/v1/purchasing/payment-evidence`: multipart `file`, `evidenceId` (client UUID for
  retry), and `payment` (JSON). The file must be a PDF, JPEG, PNG or WebP, at most 5 MB.
  Bytes are stored privately with an immutable SHA-256 digest, uploader, tenant and branch.
  Public upload URLs and client claims such as `verified: true` are not accepted.
- `GET /api/v1/purchasing/payment-evidence/:id`: authorized attachment download with
  `Cache-Control: private, no-store`; no public file URL is issued.
- `POST /api/v1/purchasing/payment-evidence/:id/revoke`: exact body `{ "reason": "..." }`,
  at most 500 characters. The uploader or a currently authorized tenant manager can revoke
  unused evidence. Consumed evidence stays retained; correct the original ledger payment
  through its normal workflow. Identical file bytes can be rebound after revoking an unused
  incorrect upload; one active/consumed document cannot support multiple payment records.
  This is deliberate: one proof backing two payments is how a payment gets recorded twice.
  Where a bank statement lists several supplier payments, upload a per-payment page, extract or
  screenshot for each one.
- `POST /api/v1/purchasing/payments/evidenced`: exact body `{ "evidenceId": "...", "payment": ... }`.
  Accepts `Idempotency-Key` in scope `supplier_evidenced_payment`. Returns the normal payment
  row plus `evidenceId` and `evidenceDigest`. Identical retries, including a later different key,
  return the already linked payment without another settlement or success audit.

The exact `payment` object requires all seven fields below and rejects unknown fields:

```json
{
  "supplierId": "supplier-uuid",
  "paidOn": "2026-10-30",
  "amount": "25.00",
  "method": "bank_transfer",
  "reference": "BANK-123",
  "notes": null,
  "allocations": [{ "invoiceId": "invoice-uuid", "amount": "25.00" }]
}
```

Methods are `bank_transfer`, `cheque` and `card`; `cash` and `other` are excluded. Money is
positive decimal text with at most two decimal places. Require a nonempty reference (at most
100 characters), `notes` as text (at most 1000 characters) or null, and 1–250 distinct explicit
invoice allocations summing to the payment amount. No implicit oldest-due allocation is used.
The upload response returns canonical payment material (normalized UUIDs/money/text and sorted
allocations); use that material unchanged when recording.

Upload and recording bind the supplier, method, date, amount, reference, notes and allocations
to the exact branch invoices and their material identity/total. Recording locks invoices and
evidence, checks current outstanding amounts, uploader ownership and live permission, then
commits payment, allocation, settlement, document consumption, idempotency and success audit
together. Authority and binding are rechecked after later database waits. Changed/revoked,
wrong-tenant/branch/uploader or consumed-for-another-write evidence is refused with 403
`PAYMENT_EVIDENCE_REQUIRED` and a message naming the cause. An invoice whose number, date or
total changed after upload makes the evidence unusable: revoke it and upload again. Reusing an
idempotency key for another binding returns 409. Upload intake itself never settles an invoice.
The document is an attributed supporting record; it does not assert independent bank settlement
verification. W5 still owns the complete attachment/review UI and legacy caller migration.

## Signed terminal commands (P1, desktop contract v1)

How an enrolled desktop counter executes a physical operation and recovers its original
result. The P2 desktop client is built against this section and the shared types in
`packages/shared/src/terminal-command-execution.ts` (`TerminalCommandPrepareRequest`,
`TerminalCommandExecuteRequest`, `OnlineCommandReceipt`, `SignedOperationBody`,
`SignedOperationResult`). Enrollment and staff-session binding use the existing
`TerminalTrustService` protocol (`terminal_enrollment` / `terminal_session` challenges), exposed
over HTTP by P2; see "Desktop enrollment and staff sessions" below. PIN sign-in belongs to P2.

**Attendance.** `attendanceProofId` must name a proof recorded through
`POST /terminals/attendance-proofs` for this command's challenge (purpose `command`). Without one
the server answers `LOCAL_ATTENDANCE_UNAVAILABLE`. The browser routes for these operations are
unchanged and are not yet restricted to terminals.

**Operating hours (P1 MR 7, revised D8).** After attendance, the server checks the branch's
selling hours for operations that sell or open a shift: the structured weekly hours (W7), dated
exceptions including confirmed gazette holidays, the owner's mandatory limits and unrevoked
business extensions, in the branch's timezone at authorization time. Back-room stock operations
(stocktake post, held write-off post, held delivery post, import stock post and undo, transfer
dispatch and receipt, prepared receipt post, supplier return completion and direct adjustments)
are reviewed as not selling-time restricted; every other operation,
including any added later and not reviewed, is hours-checked. Online commands never carry an
hours exception: `operatingHoursExceptionId` must be `null` (`INVALID_COMMAND` otherwise). The
online remedy for after-hours selling is a business extension approved on the web; the
device-signed D8 acknowledgement is offline-outage evidence only.

### Endpoints

Both take a Bearer staff token and `x-branch-id`, pass the normal guard chain, and return 200.
The route permission is `terminal.execute`. By default it goes to owner, manager and inventory
clerk, and to every role holding one of the v1 operation permissions. It is only a gate: each
command also needs its own operation permission, and both are rechecked live inside the
transaction.

- `POST /terminal-commands/prepare` — body `{ workSessionId, operation, body,
  approvalEvidenceId, pharmacistEvidenceId, operatingHoursExceptionId }` (exactly these keys).
  Checks the staff session, the operation's permission and the strict body, then returns an
  unsigned `OnlineTerminalCommand` with a server-issued `commandId`, single-use `serverNonce`
  and a 2-minute `issuedAt`/`expiresAt` window. No business effect.
- `POST /terminal-commands/execute` — body `{ command: Signed<OnlineTerminalCommand>,
  attendanceProofId }` (exactly these keys). Returns an `OnlineCommandReceipt`, for the first
  execution and for every replay.
- `POST /terminal-commands/pharmacist-cosigns` — body `{ workSessionId, operation, body,
  pharmacistUserId, pin }` (exactly these keys). A registered pharmacist co-signs one clinical
  command for the person signed in at this counter. Returns `{ pharmacistEvidenceId,
  pharmacistUserId, pharmacistRegistrationId, expiresAt }` (below, "Pharmacist co-sign").

### v1 operations

| `operation` | `body` (exact keys) | `approvalEvidenceId` | Permission |
| --- | --- | --- | --- |
| `POST /api/v1/stocktakes/:id/post` | `{ stocktakeId }` | the stocktake's current approval | `stocktakes.review` |
| `POST /api/v1/inventory/held-adjustments/:id/post` | `{ heldAdjustmentId }` | the request's current approval | `inventory.write_off` |
| `POST /api/v1/purchasing/held-deliveries/:id/post` | `{ heldDeliveryId }` | the delivery's current approval | `purchasing.receive` |
| `POST /api/v1/products/import/:importId/stock/post` | `{ importId, version, selection, categoryName }` | `null` | `products.import` |
| `POST /api/v1/products/import/:importId/undo-stock` | `{ importId }` | `null` | `products.import` |
| `POST /api/v1/transfers/:id/ship` | `{ transferId }` | the transfer's `executionApprovalId`; `null` only while approval is waived (below) | `transfers.manage` |
| `POST /api/v1/transfers/:id/receive` | `{ transferId, dispatchApprovalId, lines: [{ transferItemId, qty, receivedQtyBefore }] }` | `null` | `transfers.manage` |
| `POST /api/v1/sales/refund-requests/:id/execute` | `{ refundRequestId }` | the request's `executionApprovalId`; `null` when it needs no approval (below) | `sales.refund` |
| `POST /api/v1/purchasing/prepared-receipts/:id/post` | `{ preparedReceiptId }` | the prepared delivery's current approval | `purchasing.receive` |
| `POST /api/v1/returns/:id/complete` | `{ goodsReturnId }` | the return's latest approval | `returns.process` |
| `POST /api/v1/inventory/adjustments` | `{ kind, movementType, productId, batchId, newBatch, qty, reason, fromQuarantine }` | `null` | `inventory.manage` to add stock, `inventory.write_off` to write it off |
| `POST /api/v1/prescriptions` | `{ rxNumber, patientName, doctorName, doctorRegNo, issuedOn, validUntil, customerId, notes }` | `null` | `prescriptions.create`, plus a current SLMC registration; with a pharmacist's co-sign, `sales.pos_use` and the co-signer's registration (below) |
| `POST /api/v1/offline-stock-cases/resolutions/:id/execute` | `{ resolutionId, counts: [{ batchId, countedQty }] }` (`counts` empty unless the plan is `count_and_correct`) | the plan's `executionApprovalId` (always required) | `inventory.manage` ([P5 #51](#offline-stock-case-resolution-p5-51)) |

Direct adjustments: every key is present. `movementType` is `adjustment_in`/`adjustment_out` for
a `correction` (which also needs a `reason`) and `null` otherwise. `batchId` is `null` only with
`newBatch: { batchNo, expiryDate: "YYYY-MM-DD", costPriceMinor, sellingPriceMinor, supplierId }`,
which only an increase may carry; prices are LKR minor units. `reason` and `batchNo` are exact,
trimmed text; `fromQuarantine` is a write-off option. The grant follows the signed direction. A
write-off that needs approval is refused (`WRITE_OFF_APPROVAL_REQUIRED`) with no effect, receipt
or spent nonce; it goes through a held request instead. Each command is its own adjustment: a
retry of the same command replays the original result (`stock_adjustment.posted` with `batchId`,
`movementType`, `qty`, `stockReferenceId`), and a distinct command adjusts again. The
`inventory.adjustment` audit carries the command provenance.

Prescriptions (clinical): a current SLMC registration recorded by an owner
(`admin/pharmacist-registrations`) at the branch, with an active account and a role there, is
needed. It is either the signed session's staff member's own (`pharmacistEvidenceId: null`), or a
registered pharmacist's who co-signed with their PIN (`pharmacistEvidenceId` set; "Pharmacist
co-sign" below). No role, permission or ownership substitutes for it: an owner or manager with no
registration and no co-sign is refused with `PHARMACIST_REQUIRED`, with no effect, receipt or spent
nonce, and so is a command prepared before the registration was revoked. Every key is present:
`rxNumber`, `doctorRegNo`, `validUntil`, `customerId` and `notes` may be `null` (a `null`
`rxNumber` is allocated `RX-#####` from the branch sequence). Text is exact and trimmed with the
browser route's limits, dates are `YYYY-MM-DD`, and `validUntil` may not precede `issuedOn`.
Result: `{ type: "prescription.recorded", prescriptionId, rxNumber, pharmacistRegistrationId }`,
the registration relied on (the co-signer's when co-signed).
Each command is its own prescription, and a retry replays the original result. The
`prescription.recorded` and `terminal.command_executed` audits carry the command provenance:
`pharmacistRegistrationId`, `pharmacistUserId` (whose registration that is) and
`pharmacistEvidenceId` (the co-sign spent, or `null`), separately from the actor, who is the
session's staff member. Recording a prescription is counter work, so it is hours-checked.

**Pharmacist co-sign** (P1 #47). A cashier records a prescription with a registered pharmacist's
PIN, without the pharmacist switching in:

1. `POST /terminal-commands/pharmacist-cosigns` with the exact body the command will carry, the
   pharmacist (from `GET /sales/pos/approvers`, which lists only registered pharmacists) and their
   PIN. The caller's open counter session (`workSessionId`), `terminal.execute` and `sales.pos_use`
   are checked first (`SESSION_INVALID`, `PERMISSION_DENIED`). The PIN is then checked as at
   checkout: the co-signer needs `prescriptions.create` at the branch, and a wrong PIN counts towards
   their own lockout and is **403** `APPROVER_PIN_INCORRECT`, `APPROVER_PIN_LOCKED` or
   `APPROVER_PIN_SWITCHED_OFF` (no PIN set: their login password, as at checkout). Last, the
   co-signer needs a current registration at the branch, or **403** `APPROVER_NOT_QUALIFIED`. The
   co-sign issued is bound to the tenant, branch, counter session, the person signed in there,
   the operation and a SHA-256 of `canonicalJson({ operation, body })`. It expires after 5 minutes
   and is audited (`pharmacist_cosign.issued`, with the co-signer and registration).
2. `prepare` and `execute` the command with `pharmacistEvidenceId` set to it. A co-signed command
   needs `sales.pos_use` from the signed-in person instead of `prescriptions.create`; everything
   else (terminal proof, attendance, hours, live authority) is unchanged. Inside the execution
   transaction the co-sign is locked and must match the command's session, staff member, operation
   and body and be unspent and unexpired, or **403** `COSIGN_INVALID`. The co-signer's registration
   is checked again with the same share lock as any clinical check (`APPROVER_NOT_QUALIFIED`), and
   the co-sign is marked spent by this command with the registration relied on. A refusal rolls all
   of it back, so only a command that succeeds spends a co-sign; a second command cannot use it.
3. A lost response is resent identically and replays the original receipt; the receipt is looked up
   before any clinical check, so the spent co-sign is not needed again. `COSIGN_INVALID` and
   `APPROVER_NOT_QUALIFIED` on a resend prove the command never ran.

The PIN is used only by step 1. It is not stored, and not part of the co-sign, the signed body, the
request digest, the receipt or any audit. Co-signs are retained: they are spent once, otherwise
immutable, and never deleted (database trigger). The unsigned browser `POST /prescriptions` is
unchanged and takes no co-sign.

Import posting: `selection: "all"` posts every remaining staged row and needs
`categoryName: null`; `selection: "category"` posts one category (`categoryName: null` means
uncategorised rows). `version` is the displayed staged-stock version.

Transfers: dispatch is signed at the **source** counter (`x-branch-id` and the command identity =
source branch) and receipt at the **destination** counter (both = destination branch); the
enrollment is branch-bound, so a source device cannot book stock in at the destination. Dispatch
carries `approvalEvidenceId: null` only when the transfer is approved with no evidence and the
tenant has `approvalRequiredForBranchTransfers = false` — re-read in the transaction; anything
else needs the exact approval (`APPROVAL_REQUIRED` / `APPROVAL_INVALID`). Receipt pins the
dispatch with `dispatchApprovalId` (the transfer's `executionApprovalId`, `null` if waived) and
counts each line once: `receivedQtyBefore` is the line's `receivedQty` the counter saw, and a
mismatch is **409** (never a second receipt). Results: `{ type: "transfer.dispatched",
transferId, approvalId, dispatchedQty, effect }` and `{ type: "transfer.received", transferId,
dispatchApprovalId, status, receivedQty }`.

Prepared refunds: the counter executes a request prepared remotely (stock back, money out). It
needs approval evidence when the request was prepared at or over
`approvalRequiredReturnThreshold`, or the threshold has since been lowered to its amount;
otherwise `approvalEvidenceId` must be `null`. Cash movement is resolved from the request (its
`refundMethod`, or the sale's payments), so a cash refund is classified as branch cash. Result:
`{ type: "sale_refund.executed", refundRequestId, approvalId, goodsReturnId, amountMinor,
refundedTo: [{ method, amountMinor }], effect }` (LKR minor units). A request executes once: a
later distinct command gets `effect: "already_applied"` with an empty `refundedTo`.
`pharmacistEvidenceId`
must be `null` for every v1 operation except prescriptions (a pharmacist's co-sign, above), and
`operatingHoursExceptionId` must be `null` for every v1 operation. Any other operation,
key, type or coercion is `INVALID_COMMAND`.

### Work waiting at the counter (P2b)

`GET /api/v1/counter-work` (`x-branch-id`; `terminal.execute`; a `@CounterRoute()`) lists what was
approved on the web and waits for this branch's counter to execute. It is read-only and projects
the existing documents (no model of its own): approved prepared receipts and held deliveries on a
receivable order, approved transfers leaving this branch (approval present, or waived by
`approvalRequiredForBranchTransfers`), transfers on their way here, refund requests the refund list
calls `readyAtCounter` (plus open ones whose approval was revoked), approved stocktakes, approved
held write-offs, approved supplier returns, staged import stock not yet posted, and approved
offline stock case plans (`stock_case`, P5 #51; `reference` is the sale's invoice number). Each kind is
listed only to a caller holding that operation's own permission at the branch; `amount` on
purchasing, write-off and supplier-return items is `null` without `costs.view`.

Each item: `{ kind, id, reference, subject, lineCount, amount, readyAt, requested, approved,
dispatched, approval: { evidenceId, approvedVersion, currentVersion, state, changes }, operation }`,
newest first. `requested` / `approved` / `dispatched` are `{ name, at }` or `null`. `state` is
`matches` (the pinned approval's version and material digest equal the document now), `changed`
(something moved since approval, e.g. the order under a held delivery; `changes` names what, in
words), `revoked`, or `not_needed`. Execution itself still goes through
`POST /terminal-commands/execute` with `operation`, which re-checks everything.

### Envelope, canonical bytes and digest

```text
Signed      = { algorithm: "Ed25519", keyId, payload, signature }        // exactly 4 keys
payload     = { contractVersion: 1, kind: "online_operation", commandId,
                identity: { tenantId, branchId, terminalId, enrollmentId, keyId },
                session:  { registerId, tillId, workSessionId, staffUserId },
                operation, issuedAt, expiresAt, serverNonce, body,
                approvalEvidenceId, pharmacistEvidenceId, operatingHoursExceptionId }
signingText = "PharmaCeylon:terminal:v1:command\n" + canonicalJson(payload)
signature   = base64url(Ed25519(UTF-8(signingText))), no padding (86 chars)
requestDigest = lowercase hex SHA-256 of UTF-8(signingText)
```

- Sign the payload returned by `prepare` **verbatim**. Do not add, drop or change any field.
  The server verifies with the public key pinned at enrollment; `keyId` must equal
  `identity.keyId`.
- `canonicalJson` is `terminalSigningText` in `@pharmaceylon/shared`: object keys sorted in JS
  default string order, no whitespace, `JSON.stringify` for strings/booleans/null, safe
  integers only (no floats or `-0`), plain objects/arrays only. Quantities are base units and
  money is LKR minor units. Limits: depth 16, 10,000 values, 32,768-char strings, 128-char keys,
  131,072 encoded bytes.
- `requestDigest` is also the challenge digest and the value an attendance proof must bind. The
  signature is not part of it.
- `attendanceProofId` (1–128 chars) is opaque to P1. P2's provider must bind it to purpose
  `command`, the terminal identity, the staff user, register/till and `requestDigest`.

### Receipt and replay

```text
OnlineCommandReceipt = { contractVersion: 1, kind: "online_command_receipt", receiptId,
  commandId, identity, workSessionId, operation, requestDigest, actorUserId,
  recordedAt /* epoch ms */, replayed, result }
```

`result` is a compact per-operation summary (`SignedOperationResult`), not the screen view.
It is stored with the receipt and returned identically every time; only `replayed` differs.
`effect: "already_applied"` means a *different* command found the work already done, so it
had no second effect.

The server handles `execute` in one READ COMMITTED transaction:

1. Strict parse. The signed tenant and branch must equal the caller's tenant and `x-branch-id`.
2. Take a transaction-scoped lock on this command identity (tenant + enrollment +
   `commandId`). Only requests carrying the same command wait on each other.
3. Look up the receipt by tenant + enrollment + `commandId`.
4. **Receipt found: replay.** All of the following must hold:
   - the enrollment is active (otherwise `TERMINAL_REVOKED`);
   - the signature verifies with the pinned key;
   - the caller is the original staff user with a current token;
   - the caller still has the branch assignment, `terminal.execute` and the operation's
     permission (otherwise 403, usually `PERMISSION_DENIED`);
   - branch, terminal, key, operation and `requestDigest` match.

   The server returns the stored receipt with `replayed: true` and writes nothing. No
   attendance proof, live challenge, open staff session or time limit is required, and replay
   does not wait for the enrollment lock. A content difference is `409 REPLAY_CONFLICT`.
5. **No receipt: execute.** The server locks the enrollment row, which serializes execution
   per terminal; a revoked enrollment or retired terminal is `TERMINAL_REVOKED`. It then
   verifies the session, live permission, challenge,
   signature, attendance, exact approval and evidence ports, then rechecks them after lock
   waits. It runs the same domain core the browser route uses (StockService only). The
   domain success audit records requester, approver and executor plus terminal, session,
   command and attendance provenance. Then it writes `terminal.command_executed` and inserts
   the receipt (`offline_sequence` NULL). Any failure rolls back all of it, including nonce
   consumption.
6. Notifications run only after commit, and their failure never affects the receipt.

Identical concurrent retries wait on the command lock and then replay, giving one effect,
one audit chain and the same receipt. A retry of an already-committed command never queues
behind other work on the terminal. A replay that overlaps a revocation still being committed
may succeed, because it is read-only and runs without the enrollment lock.

**Client rules:**

- Persist the signed envelope before sending `execute`, and keep it until you get a receipt or
  a definitive error.
- After a timeout, 5xx or dropped connection, resend the identical envelope.
- Allow at least 130 seconds for a response. A retry sent while its original is still running
  (a large import post can take up to the server's 120-second transaction limit) waits for that
  original, then returns its receipt. Retrying sooner is harmless: the request is still
  uncertain, so resend the same envelope again.
- `CHALLENGE_EXPIRED` / `CHALLENGE_INVALID` for that envelope means it was definitively not
  executed, because the receipt lookup runs first. Prepare a new command if you still want the
  operation.

**Sequences:** online commands carry none. Their identity is the server-issued `commandId`, and
ordering per terminal is the server's lock order. Offline sequences belong to P5: positive,
unique per tenant + enrollment, strictly increasing and never reset; see
[offline journal sync](#offline-journal-sync-p5-51).

### Errors

Every error from a terminal route (`/terminals/*`, `/terminal-commands/*`) is the shared
`TerminalApiError`, guard refusals included (`TerminalErrorFilter`):

```text
TerminalApiError = { contractVersion: 1, code, message, correlationId, retryable }
  + statusCode (the HTTP status) + any fields of the refusal's own (PIN_LOCKED: lockedUntil)
```

- `code` and `message` are what the refusal always sent. A refusal with no code of its own
  gets one by status: 400 `BAD_REQUEST`, 401 `AUTHENTICATION_REQUIRED` (the access token was
  refused: refresh it, then send again), 403 `FORBIDDEN`, 404 `NOT_FOUND`, 409 `CONFLICT`,
  429 `RATE_LIMITED`, other 4xx `REQUEST_REFUSED`, 5xx `SERVER_ERROR`. A DTO's list of problems
  becomes one message joined with `; `. A fault that is not an HTTP refusal is 500
  `SERVER_ERROR` with the message `Internal server error`.
- A domain refusal from the core a signed command runs keeps that core's code (for example
  `COST_CONFLICT`).
- `correlationId` is a UUID minted for this error (the API has no request ID). The server logs
  one `terminal.error` line with the same ID, status, code, method and route pattern, never
  the message; with `STRUCTURED_HTTP_LOG=true` the access-log line carries it too. Quote it
  when reporting a problem.
- `retryable` comes from `TERMINAL_ERROR_RETRYABLE` in `@pharmaceylon/shared`, one row per code.
  It is true only for `TEMPORARILY_UNAVAILABLE`, `RATE_LIMITED` and `SERVER_ERROR`: resending
  the identical request may succeed. Every other code, and any code not in the table, is a
  decision about the request as sent. The client may still fix the cause and send a new
  request, such as a freshly prepared command.
- `retryable` says the server decided nothing, not that a resend is harmless. After a 5xx the
  first attempt may still have committed. A signed command (`/terminal-commands/execute`) is
  safe to resend because it replays from its receipt. Any other terminal route is resent only
  where its own contract says a repeat replays; otherwise read the current state first (for
  example, list the enrollment codes before issuing another).

Errors raised before routing (malformed JSON, an unknown path) keep the platform body
`{ statusCode, message, error }`. So does every route outside the terminal modules.

| HTTP | `code` | Meaning |
| --- | --- | --- |
| 400 | `INVALID_COMMAND` | Malformed or unknown operation, bad keys or evidence IDs, non-canonical body. Definitive. |
| 403 | `IDENTITY_MISMATCH` | Tenant, branch, terminal, key, operation or staff mismatch, or a replay by another user. Definitive. |
| 403 | `INVALID_SIGNATURE` | Definitive. |
| 403 | `TERMINAL_REVOKED` | Revoked enrollment or retired terminal. Also blocks replay; recover in the back office. |
| 403 | `SESSION_INVALID` | Staff session closed or token version changed. Re-authorize and prepare again. |
| 403 | `CHALLENGE_EXPIRED`, `CHALLENGE_INVALID`, `CHALLENGE_USED_OR_EXPIRED` | Not executed. Prepare again. |
| 403 | `LOCAL_ATTENDANCE_UNAVAILABLE` | Attendance not proven. Not executed. |
| 403 | `PERMISSION_DENIED`, `APPROVAL_REQUIRED`, `APPROVAL_INVALID` | Not executed. |
| 403 | `BRANCH_HOURS_NOT_CONFIGURED` | Selling-hours operation at a branch whose hours are unset, whose timezone is unusable or that is inactive (or no hours provider installed). Not executed and not retryable: a manager sets the branch hours (the owner fixes the timezone), then the counter prepares a new command. |
| 403 | `TEMPORARILY_UNAVAILABLE` (`retryable: true`) | Selling-hours operation at a branch whose stored hours the server cannot read. Every save validates the hours, so this is a server fault (for example hours a newer release saved, read during a rolling deploy), not setup. Not executed; resend the identical envelope with backoff. |
| 403 | `OUTSIDE_OPERATING_HOURS` | Outside the owner's mandatory limit. Nobody can override it. Not executed. |
| 403 | `BUSINESS_HOURS_ACK_REQUIRED` | Outside routine hours with no business extension. A manager can approve an extension on the web. Not executed. |
| 409 | `REPLAY_CONFLICT` | This `commandId` already committed with different content. Definitive. |
| 400/404/409 | The domain core's own code, or `BAD_REQUEST`/`NOT_FOUND`/`CONFLICT`, with its message, e.g. "Approval changed; refresh and review before posting" | Not executed. |
| 5xx | `SERVER_ERROR` (`retryable: true`) | **Uncertain.** Resend the identical envelope. |
| network | — | **Uncertain.** Resend the identical envelope. |

Receipts are not server-signed in v1; the client trusts them over TLS. A signed `sync_response`
is reserved for P5 offline sync.

## Offline-counter assignment (P1 / revised D13)

Which enrolled counter may become the branch's offline-capable terminal is decided in two
separate steps. These endpoints are the first, online and remote-capable; they nominate nothing,
issue no grant and need no terminal proof. All need `x-branch-id`, a live sign-in and the route
permission `tenant.management`, which is never sufficient by itself. Every response is the
`OfflineAssignmentView` (`@pharmaceylon/shared`) for the branch.

| Route | Who | Effect |
| --- | --- | --- |
| `GET /terminals/offline-assignment` | branch staff with `tenant.management` | Current nomination (`nominationVersion`, 0 = none) including `activatedAt`, `activatedByUserId`, `activatedByFullName` when nominated; every active delegation plus up to 50 recent revoked delegations (newest first), recent authorizations. |
| `POST /terminals/offline-assignment/delegations` `{ managerUserId }` | **owner only** | Delegates assignment to one manager for this branch. The delegate must be assigned here and hold `tenant.management` here. Idempotent. Managers cannot delegate onward; no role edit creates a delegation. |
| `POST /terminals/offline-assignment/delegations/:delegationId/revoke` `{ reason }` | owner only | Revokes it, and revokes the delegate's outstanding authorization. |
| `POST /terminals/offline-assignment/authorizations` `OfflineAssignmentAuthorizeRequest` | owner, or a manager with a live delegation for this branch | Authorizes one exact active enrolled target at this branch and the `expectedNominationVersion` shown. Supersedes the branch's previous outstanding authorization. `authorizationId` is client-generated: resending is a no-op, reuse for anything else is 409 `AUTHORIZATION_ID_CONFLICT`. |
| `POST /terminals/offline-assignment/authorizations/:authorizationId/revoke` `{ reason }` | owner or delegated manager | Revokes an outstanding authorization. |

Refusals carry `code`: `OFFLINE_ASSIGNMENT_OWNER_ONLY`, `OFFLINE_ASSIGNMENT_NOT_DELEGATED`,
`OFFLINE_DELEGATE_INELIGIBLE` (403); `OFFLINE_TARGET_INVALID` (not an active, counter-bound
enrollment at this branch), `NOMINATION_VERSION_CHANGED`, `OFFLINE_TARGET_ALREADY_NOMINATED`,
`AUTHORIZATION_ID_CONFLICT` (409). Delegations and authorizations are retained: content is
immutable, revocation/consumption is recorded once, nothing is deleted.

**Activation (second step, P2).** On the exact target, a staff member holding
`terminal.activate_offline` (owner and manager by default; not the owner's assignment authority)
confirms from their own open staff session there:

1. `POST /terminals/offline-assignment/activate/challenge` `OfflineActivationPrepareRequest` →
   `OnlineTerminalCommand<{ authorizationId, expectedNominationVersion }>` (operation
   `POST /api/v1/terminals/offline-assignment/activate`).
2. Record an attendance proof for that command (purpose `command`) and
   `POST /terminals/offline-assignment/activate` `{ envelope, attendanceProofId }` →
   `OfflineActivationResult`.

In one transaction the server verifies the signed command and attendance, calls
`OfflineAssignmentService.requireCurrent` (authorization outstanding for this exact
terminal/enrollment/key, enrollment active, nomination version unchanged, original authorizer still
an owner or still a delegated manager with branch management), applies D11 clearance, marks the
authorization `consumed` by the activator, writes `offline_terminal_nomination` at `version + 1`
and audits `terminal.offline_activated` with authorizer and activator separately. Concurrent
activations serialize on the enrollment and branch locks; only one consumes the authorization.
D11: a branch's first nomination is cleared. Replacing a nominated terminal needs both halves,
checked with the branch's nomination row locked:

1. **P3, the authority cutoff.** The old counter must no longer be able to sell offline: it is
   confirmed disabled (enrollment revoked or terminal retired), or the latest grant the server
   issued it has expired (`now >= expiresAt`), or it was never issued one. Otherwise 409
   `D11_CLEARANCE_REQUIRED` reason `PREVIOUS_STILL_ACTIVE`, with `authorityCutoffAt` (epoch ms)
   saying when its last grant expires.
2. **P5, missing-journal recovery and review.** Not supplied yet, so replacement still fails
   closed with reason `OFFLINE_RECOVERY_EVIDENCE_REQUIRED` (`authorityCutoffAt` is the cutoff, or
   `null` when the old counter never held a grant).

Revocation is a cutoff for the server, not for a disconnected device: the grant it already holds
is reported as `lastGrantExpiresAt` in the activation audit, for the journal review to account
for. Stale, revoked or consumed authorizations are
409 `OFFLINE_AUTHORIZATION_NOT_CURRENT` and need renewal. Activation issues no grant.

## Desktop enrollment and staff sessions (P2)

Routes under `/api/v1/terminals`, all with `x-branch-id` except the PIN sign-in below. Bearer auth from the desktop's main
process (no cookie, so no CSRF). Shared types: `packages/shared/src/terminal-enrollment.ts` and
`terminal-attendance.ts`. The route permission is a gate only: `TerminalTrustService` rechecks
live authority, the server challenge, the device signature and the attendance proof inside one
transaction. Nothing here nominates an offline terminal, issues a grant or opens a financial shift.

| Route | Permission | Body / result |
| --- | --- | --- |
| `GET /terminals/counters` | `tenant.management` | `TerminalCounterView[]` — registers, tills and the terminal on each |
| `POST /terminals/counters` | `tenant.management` | `{ label }` → `TerminalCounterView` |
| `POST /terminals/enrollments/challenge` | `tenant.management` | `TerminalEnrollmentChallengeRequest` → `TerminalEnrollmentCommand` (two-minute challenge) |
| `POST /terminals/enrollments` | `terminal.execute`; `tenant.management` too unless the challenge came from a code | `{ envelope, attendanceProofId }` → `TerminalIdentity`; 409 `COUNTER_OCCUPIED` if a computer enrolled there first |
| `GET /terminals/enrollments/:enrollmentId` | `terminal.execute` | `TerminalEnrollmentStatusView`: `label` = device name; `counterLabel` = human till name (`TerminalCounter.label`); `offlineBackup` = epoch-ms authorization/activation timestamps and actor ids plus `authorizedByFullName` / `activatedByFullName` when this enrollment is nominated (activation) or has an **outstanding** `status: authorized` assignment authorization (otherwise each field null; revoked unconsumed authorizations are omitted; consumed authorization linked to the active nomination still surfaces). **Counter-role callers** deliberately receive authorizer/activator user ids and display names here (approved This counter mockup). |
| `POST /terminals/enrollments/:enrollmentId/revoke` | `tenant.management` | `{ reason }` → 204; closes its staff sessions |
| `POST /terminals/devices/:terminalId/retire` | `tenant.management` | `{ reason }` → 204; frees the counter for a replacement |
| `GET /terminals/enrollment-codes` | `tenant.management` | `TerminalEnrollmentCodeView[]` (newest 50; never the codes) |
| `POST /terminals/enrollment-codes` | `tenant.management` | `{ registerId, expiresInMinutes? }` → `TerminalEnrollmentCodeIssued` (code shown once) |
| `POST /terminals/enrollment-codes/:codeId/revoke` | `tenant.management` | → `TerminalEnrollmentCodeView` |
| `POST /terminals/enrollments/code-challenge` | `terminal.execute` (throttled 10/min) | `TerminalEnrollmentCodeChallengeRequest` → `{ command, counterLabel }` |
| `POST /terminals/attendance-proofs` | `terminal.execute` | signed `LocalAttendanceAttestation` → `LocalAttendanceProofReceipt` |
| `POST /terminals/sessions/challenge` | `terminal.execute` | `{ identity }` → `TerminalSessionCommand` |
| `POST /terminals/sessions` | `terminal.execute` | `{ envelope, attendanceProofId }` → `WorkSessionIdentity` |
| `POST /terminals/sessions/:workSessionId/end` | `terminal.execute` | 204; deauthorizes the binding, not a cash close |
| `POST /terminals/sessions/:workSessionId/test-receipt` | `terminal.execute` | `{ printerName }` → `{ testReceiptId, confirmedAt }`; go-live evidence that a test receipt printed here |
| `GET /terminals/sessions/:workSessionId/credential` | `terminal.execute` | `TerminalStaffCredentialView` for the caller's own open session |
| `POST /terminals/sessions/:workSessionId/pin` | `terminal.execute` | `{ pin, password }` → `TerminalStaffCredentialView`; sets/changes the caller's PIN |
| `POST /terminals/sessions/:workSessionId/prepare` | `terminal.execute` | `{ pin }` → `TerminalStaffCredentialView`; prepares this counter |

**Enrollment.** The desktop generates an Ed25519 key in its main process, gets a challenge for one
register, signs the returned payload verbatim with `terminalSigningText("command", payload)`,
records an attendance proof for it, then finishes with `POST /terminals/enrollments`. Two ways to
get the challenge:

- *Manager at the computer:* `POST /terminals/enrollments/challenge`, needing `tenant.management`.
- *Enrollment code:* a manager issues a one-time code for one free counter (web Counters screen,
  W6, or the desktop) and any branch staff member at the computer redeems it with
  `POST /terminals/enrollments/code-challenge`. Codes are 10 Crockford base32 characters shown as
  `XXXXX-XXXXX` (case, spaces and dashes are ignored; O/I/L read as 0/1), stored only as SHA-256,
  single use, revocable, expire after 5–1440 minutes (default 60) and are scoped to one branch and
  counter. The challenge row remembers the code; finishing locks and rechecks it (unused,
  unrevoked, unexpired, same counter) and marks it used with the new enrollment in the same
  transaction. A bad, used, revoked or expired code is 403 `ENROLLMENT_CODE_INVALID`; a code for an
  occupied counter cannot be issued (409 `COUNTER_OCCUPIED`). The person who finishes is recorded
  as the enroller and the audit names the code and its issuer.

**Staff sessions.** Any staff member with branch access signs in on an enrolled desktop; the
desktop asks for a session challenge, signs it with the enrolled key, records an attendance proof
and finishes. One open session per till; a token-version bump (logout-all, role change) ends it.

**Personal PINs (D-W5).** One PIN per person, 4–8 digits, set or changed only at an enrolled
counter through the caller's own open staff session, with their login password. Any branch staff
member may set one (the older `/sales/pos/me/pos-pin` route stays limited to approvers). The server
keeps the bcrypt verifier for online co-sign; every set, change, clear or admin reset bumps
`posPinVersion`. A counter is *prepared* for a person when they enter the PIN there while online
(`prepare`, or implicitly when they set it there): the server records
`terminal_staff_preparation(enrollment, staff, pinVersion)` and the desktop stores its own scrypt
verifier for that version. A PIN change elsewhere leaves other counters stale until the person signs
in there again. Wrong PINs share the co-sign lockout (5 attempts, 15 minutes): `PIN_INCORRECT`,
`PIN_LOCKED`, `PIN_SWITCHED_OFF`, `PIN_NOT_SET`, `PASSWORD_INCORRECT`. The lockout escalates: the
third timed lock since the person last proved their password (`posPinLockouts`) switches the PIN
off, and a right PIN doesn't reset the count. A password sign-in, setting a PIN, or a manager's
reset turns it back on; the switch-off raises the `pin_switched_off` counter alert at the branch
once. Superseding: a new staff session at a till closes
any older open binding there (`terminal.session_superseded`); shift and cash state are separate.

**PIN sign-in at a counter (D-W5, P2b #103).** People prepared on a counter can sign in there
with their PIN instead of their email and password. Nobody is signed in yet, so both routes are
public (throttled 20/min) and carry no `x-branch-id`; the enrolled key, a console attendance proof
and the server's own PIN verifier and lockout stand in for the password.

| Route | Auth | Body / result |
| --- | --- | --- |
| `POST /terminals/pin-sessions/challenge` | public; signed by the enrolled key | `Signed<TerminalPinSessionRequest>` (`{ identity, staffUserId }`) → `TerminalPinSessionCommand` |
| `POST /terminals/pin-sessions` | public; signed by the enrolled key | `TerminalPinSignInRequest` (`{ envelope, attendance, pin }`) → `TerminalPinSignInResult` |

1. The desktop signs `{ contractVersion: 1, kind: "terminal_pin_session_request", identity,
   staffUserId }` with `terminalSigningText("command", …)`. The server checks the signature
   against a plain read of the enrollment *before* locking it (so an unsigned request can't hold
   up the counter), then locks it, checks again, and checks that the person holds
   `terminal.execute` at the branch, has a PIN, is prepared on this enrollment at their current
   `posPinVersion`, and that their PIN can be tried now. It returns a two-minute challenge
   (purpose `pin_session`, actor = that person) carrying a new `workSessionId`, the `pinVersion`
   and the `tokenVersion`. Refusals: `INVALID_SIGNATURE`, `IDENTITY_MISMATCH`, `TERMINAL_REVOKED`,
   `PERMISSION_DENIED`, `PIN_NOT_PREPARED`, `PIN_LOCKED` (with `lockedUntil`), `PIN_SWITCHED_OFF`.
   While this counter holds an open challenge for that person with more than a minute left, and
   their PIN and tokens haven't changed, the same challenge is returned again: a replayed request
   adds no rows, and what it gets back cannot be finished without the key and the PIN.
2. The desktop signs the challenge verbatim, builds a `LocalAttendanceAttestation` for it with
   purpose `pin_session` and the person as actor (signed with `"attendance"`), and sends both with
   the PIN. In one transaction the server checks the challenge and signature, records and consumes
   the proof (`pin_session` proofs are accepted only here, never by
   `POST /terminals/attendance-proofs`), rechecks the person (a role, PIN or token change since the
   challenge is `SESSION_INVALID`), **spends the challenge**, then checks the PIN against the
   shared co-sign lockout (5 wrong, 15 minutes, switched off at the third lock). A wrong or
   locked PIN commits — the guess is counted and audited as `terminal.pin_sign_in_refused` — and
   is then refused with 403 `PIN_INCORRECT`, `PIN_LOCKED` or `PIN_SWITCHED_OFF`, so each challenge
   buys exactly one guess. A refusal before the
   PIN check (`REMOTE_SESSION_DENIED`, `IDENTITY_MISMATCH`, …) rolls back and counts nothing.
3. A correct PIN opens the staff session exactly as a password sign-in would (superseding any open
   binding at the till; `terminal.session_authorized` with `via: "pin"`) and returns
   `{ accessToken, refreshToken, user, session }`.

**What a PIN login can do.** The tokens it returns are a *counter login*: the refresh session
records `counter_session_id` and the access token carries `counterSessionId`. Such a login:

- reaches only routes marked `@CounterRoute()` — the ones the desktop counter calls (sell, holds,
  approvers, refund requests list, customer and prescription look-ups, signed terminal commands,
  its own staff-session routes, the offline-assignment view and logout). Anything else, including
  opening another staff session, offline activation and every back-office, account and admin
  route, is 403 `COUNTER_SESSION_ONLY` (not 401, so clients don't refresh and retry);
- is held to the counter's branch: a different `x-branch-id` is 403, and without one the
  counter's branch is applied;
- lives only while its staff session is open: once signed out, superseded, revoked or ended, its
  access token is 401 and its refresh is refused (`counter_session_closed`);
- refreshes for up to `JWT_COUNTER_REFRESH_TTL_SECONDS` (default 12 hours) without use, not the
  two weeks of a password login. Permissions still apply on top of all of this.

**Attendance proofs.** Desktop main builds a `LocalAttendanceAttestation` naming the purpose,
identity, actor, register/till and the challenge's `payloadDigest` (sha256 of the challenge's
canonical text), plus what it read from Windows about its own session, and signs it with
`terminalSigningText("attendance", attestation)`: the candidate key for enrollment, the enrolled
key otherwise. The server requires a live, unconsumed challenge with that digest for the same
actor and branch, an exact identity/counter match, a valid signature and
`windowsSession = { protocol: "console", remoteSession: false }`. Otherwise:
`CHALLENGE_INVALID`, `IDENTITY_MISMATCH`, `INVALID_SIGNATURE`, `TERMINAL_REVOKED` or
`REMOTE_SESSION_DENIED` (403). The proof is stored unconsumed and expires with its challenge.
`proofId` is client-generated: an identical retry returns the same receipt; the same ID with
different content is 409 `REPLAY_CONFLICT`. Enrollment, session and command verification consume
it once, in their own transaction, so a failed operation leaves it usable. Freshness comes from the
server challenge; the device's `observedAt` is recorded, not trusted.

**Online checkout from a counter.** The desktop rings up sales through the normal
`POST /sales/checkout` (same pricing, VAT, FEFO, controlled-item and idempotency rules as the web
POS) with an extra `x-terminal-session: <workSessionId>` header. The server requires that session to
be the seller's own open binding on an active enrollment at this branch (`SESSION_INVALID`
otherwise) and records `sale.terminal_id`, `till_id` and `work_session_id`. This is attribution,
not authority, and it serializes sales per counter on the enrollment lock. Web POS sales leave the
columns null. Every online counter, including a nominated offline one, sells the same shared
available stock.

**Prescription and controlled items at the counter.** The desktop links a customer
(`GET /customers`) and a prescription: it finds one with `GET /prescriptions`, or records one with
the signed `POST /api/v1/prescriptions` command ("Signed terminal commands"), so the signed-in
person must hold a current SLMC registration (`PHARMACIST_REQUIRED` otherwise; a cashier asks the
pharmacist to switch in and record it). For controlled items it sends `pharmacistApproval: {
approverUserId, pin }`, the co-signer's online PIN or, without one, their login password. The
co-signer must also hold a current SLMC registration at the branch ("Pharmacist registrations",
"Controlled checkout"), and `GET /sales/pos/approvers` lists only people who do. Checkout refusals
carry `code: "PRESCRIPTION_REQUIRED"` (no prescription linked), `code:
"PHARMACIST_APPROVAL_REQUIRED"` (controlled items, a seller who cannot dispense them, no co-sign),
`code: "APPROVER_NOT_QUALIFIED"` (403: the co-signer has no current registration here) and `code:
"SELLER_NOT_QUALIFIED"` (403: a seller dispensing alone has none). Those last two are given only
after the transaction has looked up the key, so the desktop takes them as final on a resend: a
sale whose co-signer's registration lapsed before it was confirmed is cleared, not left pending. A
wrong or locked co-signer secret is **403** with `APPROVER_PIN_INCORRECT`, `APPROVER_PIN_LOCKED`,
`APPROVER_PIN_SWITCHED_OFF` (the escalated lockout above; the co-signer signs in with their
password to end it) or `APPROVER_NOT_FOUND`, as are the counter's own `PASSWORD_INCORRECT` and `PIN_INCORRECT`: a
401 means only that the access token lapsed, and clients refresh and resend on it, which would
count one wrong secret twice. Overlapping retries
of one `Idempotency-Key` serialize inside the checkout transaction, so a resend sent while the
first attempt still runs replays that sale. The desktop never stores the PIN: its draft keeps only who
co-signed. An idempotent replay returns the original sale without re-verifying it, so a resent
draft needs the PIN again only if the first request never reached the server.

**PIN status for back office (W3).** `GET /admin/users/:userId/security` adds `pin.version` and
`preparedCounters[]`: `{ terminalId, branchId, branchName, counterLabel, preparedAt, pinVersion,
current }` for active, unretired counters. `current` is true only while `pinVersion` equals the
person's PIN version and a PIN is set. `POST /admin/users/:userId/reset-pin` clears the PIN and
bumps the version, which makes every preparation stale.

**Limits (accepted for v1, D-P2a).** This is evidence that the trusted process ran in the
physical console session, not proof that a person inspected goods. Remote Desktop is refused.
Third-party remote-control tools (AnyDesk, TeamViewer, Chrome Remote Desktop and similar) drive the
console session; the desktop refuses to record a proof while a known one is running, but a renamed
process passes, so named staff attribution, training and audit remain the control. A hostile local
administrator is out of scope. Shafeek accepted these limits for v1 on 2026-11-01
([POS_V1_REVIEW.md](POS_V1_REVIEW.md), D-P2a).

**Co-sign attendance.** A controlled-item co-sign at checkout relies on the attendance proved when
the seller's session opened at that counter, not a proof bound to the sale; that is the v1 rule.

**Mandatory hours on counter sales.** A checkout carrying `x-terminal-session` is refused with
403 `OUTSIDE_OPERATING_HOURS` outside the branch's mandatory selling windows (W7), with
`BRANCH_HOURS_NOT_CONFIGURED` if the branch's timezone is unusable or the branch is inactive, and
with `TEMPORARILY_UNAVAILABLE` if the stored hours can't be read. Routine closing time stays
advisory online, and a branch with no hours set has no restriction.

**Unconfirmed sales.** The checkout idempotency key is scoped to the seller. The seller confirms
their own unconfirmed sale by resending it under the same key. Anyone else signed in at the same
enrolled counter confirms it with `POST /sales/checkout/resolve` (`sales.pos_use`, a counter
route), which looks the original up and never sends it again:

- Headers: `x-branch-id` and `x-terminal-session: <the caller's own open workSessionId>`.
- Body: `{ idempotencyKey, workSessionId }`, the original's key and the staff session it was sent
  under.
- The server finds that session at this branch and requires it to be on the caller's enrollment.
  It takes the same lock checkout takes for the seller's key, then reads the seller's checkout
  record. A first attempt that is still running finishes first.
- **200 `{ outcome: "landed", sale }`**: the committed sale, with the `POST /sales/checkout` sale
  shape. It is still the seller's (`soldBy`, `workSessionId`), and nothing is posted.
- **200 `{ outcome: "never_landed" }`**: nothing committed under the key, and now nothing can. The
  lookup seals the key for that seller (`idempotency_record` scope `checkout_sealed`, `resourceId`
  = the caller's session). A checkout with that key arriving later is refused with **409
  `CHECKOUT_SEALED`** after the key lock, so the counter can ring the sale up again under a new
  key. Asking again gives the same answer.
- **403 `CHECKOUT_OTHER_COUNTER`**: the original session isn't at this branch or on this counter's
  enrollment, or the seller's key belongs to a sale in another session. Nothing is sealed.
- **403 `SESSION_INVALID`**: the caller has no open session of their own on an active enrollment.
- Audited as `sale.checkout_resolved`, with the caller as actor and the outcome.

Who may resolve: anyone with `sales.pos_use` signed in at that counter, not only managers. The
route moves no stock or cash, attributes nothing to the caller, and only answers for this
counter's own sales. Sealing a key that never landed only stops a sale that would otherwise arrive
unannounced after the counter was told it hadn't happened. Requiring a manager would bring back
the single-person wait the route exists to remove, at a counter run by two cashiers.

**Web PIN routes.** `POST /sales/pos/me/pos-pin` and `/clear` are refused with 403
`PIN_SET_AT_COUNTER` at a branch live on PharmaCeylon POS (outside a fallback), because there the
PIN is set at the counter (D-W5). A wrong password there is 403 `PASSWORD_INCORRECT`.

**Unsigned prescription recording (decided 2026-11-03).** The unsigned `POST /prescriptions`
checks no SLMC registration, so at a branch live on PharmaCeylon POS (outside a fallback) it is
refused with 403 `PRESCRIPTION_AT_COUNTER`, whoever calls it: there prescriptions are recorded at a
counter through the signed command, which does check. During an owner's fallback the web POS is
what the branch is using, so the route works there, and at branches not live yet, as before. Both
are unchecked until the web can carry clinical evidence (W5).

## Till shifts (P2b #103)

A till shift is one person's turn at one till (the cash drawer), opened and closed with a counted
drawer. It is D7b's **work session**: the shift's ID is the `workSessionId` that `shift_open` and
`shift_close` carry, generated on the counter, so P4 writes the same record offline and P5 replays
it without conversion. The sign-in that the routes below take in their path
(`TerminalStaffSession`, also called `workSessionId` there and in `x-terminal-session`) is a
different thing: who is signed in at the counter now. A shift outlives sign-ins (lock, unlock,
switch user), and sales attach to the shift directly ([POS_P2_IMPLEMENTATION.md](POS_P2_IMPLEMENTATION.md),
D-P2b-shift).

Money is in minor units (cents of LKR). A count is `{ totalMinor, lines: [{ denominationMinor,
count }] }` in Sri Lankan notes and coins (5,000 down to 1 rupee); the server adds the lines up
again and refuses a total that doesn't match (400 `CASH_COUNT_INVALID`). Stored lines drop empty
denominations and run largest first.

All routes are `@CounterRoute()`, need `sales.pos_use`, and run on the caller's own open staff
session at an active enrollment, so the till is the session's, never a client claim.

| Route | What it does |
| --- | --- |
| `GET /terminals/sessions/:workSessionId/shifts/current` | `{ registerId, tillId, current: { shift, summary } \| null, lastClosed: shift \| null }` for the session's till |
| `GET /terminals/sessions/:workSessionId/shifts` | The till's shifts, newest first (30) |
| `GET /terminals/sessions/:workSessionId/shifts/:shiftId` | `{ shift, summary }` for one shift on this till (past shifts, the X report) |
| `POST /terminals/sessions/:workSessionId/shifts` | Open: `{ shiftId, pin, openingCount, previousClosedWorkSessionId? }` |
| `POST /terminals/sessions/:workSessionId/shifts/:shiftId/close` | Close: `{ commandId, closingCount, counterExpectedCashMinor?, varianceNote?, assistance?: { pin, reason } }` |

**Shift fields** (D7b names): `workSessionId`, `shiftNumber` (`S-0412`, numbered per branch by
the server on open; an offline open gets its number when P5 replays it), `registerId`, `tillId`, `terminalId`,
`staffUserId`, `staff`, `currency` (`LKR`), `status` (`open` / `closed`), `openedAt`,
`openingCashMinor`, `openingCount`, `previousClosedWorkSessionId`, `closedAt`,
`closingCashCountMinor`, `closingCount`, `expectedCashMinor` (server), `counterExpectedCashMinor`
(the counter's own running figure, kept beside it), `varianceMinor` (count − expected),
`closedBy`, `closeKind` (`self` / `assisted`), `assistanceReason`, `varianceNote` (what the person
counting said about a difference).

**Summary:** `openingCashMinor`, `cashTakenMinor` (cash tendered), `changeGivenMinor`,
`cashRefundsMinor`, `cashPaidOutMinor`, `cashPaidInMinor`, `expectedCashMinor` (live while open,
the recorded figure once closed), `saleCount`, `salesTotalMinor`, `firstSaleAt`, `lastSaleAt`, `takingsByMethod[]`
(`{ method, saleCount, takenMinor, refundedMinor }`, cash net of change), `takingsByHour[]`
(`{ hour: "YYYY-MM-DDTHH" in the branch's timezone, saleCount, totalMinor }`), `refunds[]`
(`{ goodsReturnId, returnNumber, invoiceNo, amountMinor, paidBack: [{ method, amountMinor }],
items: [{ name, qty, disposition }], processedBy, at }`) and `cashMovements[]`.

**Expected cash** = opening count + cash taken − change given − cash refunds − cash paid out
(+ cash paid in, which nothing writes yet). Voided sales are left out.

**Opening** needs the caller's own PIN (the server verifier and its lockout: `PIN_INCORRECT`,
`PIN_LOCKED`, `PIN_SWITCHED_OFF`, `PIN_NOT_SET`, all 403), a count, and no shift already open on the
till: 409 `SHIFT_ALREADY_OPEN` (theirs) or `SHIFT_HELD_BY_OTHER` (someone else's, with
`workSessionId`, `staffUserId`, `openedAt`). It follows checkout's hours rule: 403
`OUTSIDE_OPERATING_HOURS` outside a mandatory restriction. `previousClosedWorkSessionId`, when
sent, must name the till's last closed shift (409 `SHIFT_STATE_CHANGED`); the server records it
either way. A resend with the same `shiftId` and count replays the open; the same ID for a
different open is 409 `SHIFT_ID_USED`. Concurrent opens on a till: exactly one wins (a partial
unique index backs the counter row lock).

**Closing** is allowed outside selling hours (D8). The shift's own person closes it with the
count. Anyone else is the **absent-cashier close**: `assistance` with their own PIN and a reason,
and `shifts.close_others` (owners and managers by default), checked live; without `assistance`
it is 403 `SHIFT_ASSISTANCE_REQUIRED`, without the permission 403 `PERMISSION_DENIED`. The
original person stays `staffUserId`; the closer is `closedBy`, and `closeKind` is `assisted`. A
resend with the same `commandId` replays the close; another close of a closed shift is 409
`SHIFT_ALREADY_CLOSED`. A close waits for sales still landing on the shift, then fixes expected
cash and the variance. A closed shift never changes, enforced by a trigger, so a shortage stays on
record whatever the next opening count says. Handover is a close then the next person's open; the
end of the day is a close with no open after it.

**Counter sales and refunds.** A checkout with `x-terminal-session` needs the seller's own open
shift on that till: 409 `SHIFT_REQUIRED` with none, `SHIFT_HELD_BY_OTHER` with someone else's.
Both come after the idempotency lookup, so a counter can treat them as final. The sale and its
payments carry `shiftId`. A refund executed at a counter (the signed refund command) that pays
cash out needs the executor's open shift on that till (409 `SHIFT_REQUIRED`) and joins it, with its
goods return and negative payments carrying `shiftId`; one paying no cash joins the executor's open
shift if there is one. Web POS sales and refunds carry no shift.

**Cash movements.** `till_cash_movement` holds drawer cash that is neither a sale nor a refund.
It has no route: `TillShiftsService.recordCashMovement` writes it inside the payer's transaction,
on their own open shift, and P6's supplier cash payout (revised D10) is the first caller.

## Offline support records (P1, sync intake)

The `OfflineSupportRecord` stream (`@pharmaceylon/shared`, `pos-resilience-contracts.ts`) is what a
counter signs while offline that is evidence, not a sale or shift: D8 hours acknowledgements,
sale-incident notes and external-card attempt events. They arrive in the `supportRecords` of
`POST /terminals/offline-journal/sync` ([P5 #51](#offline-journal-sync-p5-51)), which calls
`OfflineSupportRecords.record(tx, user, branchId, signedEnvelope)`, which dispatches on the signed
`kind`. The uploader needs a live sign-in at the branch. Each record is an Ed25519 `Signed<T>`
envelope with `command` purpose, verified against the enrollment's pinned key.

| Check | Refusal |
| --- | --- |
| Unknown or missing key, wrong state fields, coerced values, untrimmed or oversized text, a possible full card number (`containsCardNumber`) in a description, provider reference or approval code | `INVALID_COMMAND` (400) |
| Identity not the caller's tenant/branch, unknown enrollment | `IDENTITY_MISMATCH` (403) |
| Signature not from the enrollment's key | `INVALID_SIGNATURE` (403) |
| `recordedAt` more than five minutes ahead of the server | `CLOCK_UNTRUSTED` (403) |

A record ID is unique per tenant + enrollment across all three kinds. The result is a
`SupportRecordReceipt`:

- **First upload.** `{ status: "held", heldReason, replayed: false }`. `heldReason` is
  `grant_unverified` (hours), `sale_unverified` (incident), `payment_unverified` (card attempt),
  `attempt_mismatch` (a card event whose draft, digest, amount, provider reference or linked sale
  disagrees with an earlier event of the same attempt), or `enrollment_revoked` (revoked or retired
  device, kept for reconciliation).
- **The same bytes again.** The original receipt with `replayed: true`.
- **Changed content under a used ID.** `{ status: "conflict", originalRecordHash }`. The original
  is unchanged and the conflicting signed upload is kept in `offline_support_conflict` for repair.
  This is a result, not an exception, so the evidence commits; the sync caller reports it to the
  device as `REPLAY_CONFLICT`.

Records stay `held` until P3/P5 verify the grant, sign-in, shift, sale and card-machine result they
cite. A held record is not accepted. These records never post a sale, payment, stock, cash or refund
effect and authorize nothing. Card-attempt events never carry card credentials, only the
provider's reference and approval code.

## Pharmacist registrations (P1)

Who counts as a qualified pharmacist is a recorded fact, not a role: an owner records each
pharmacist's SLMC registration number and the date it expires. Clinical execution needs the staff
member's **current** registration. No role, permission or ownership stands in for it, an owner's
included. Remote management (`identity`); none of these routes dispenses anything.

| Route | Who | Effect |
| --- | --- | --- |
| `GET /admin/pharmacist-registrations` | `users.view` | Every registration, current ones first: `{ id, userId, fullName, email, accountActive, slmcNumber, expiresOn, status, recordedByUserId, recordedAt, revokedAt, revokedByUserId, revocationReason }`. `status` describes the registration only: `current`, `expired` (past `expiresOn` in the tenant's timezone) or `revoked`. `accountActive` is false when the staff member's account or membership is deactivated; the check refuses them whatever `status` says. |
| `POST /admin/pharmacist-registrations` `{ userId, slmcNumber, expiresOn: "YYYY-MM-DD" }` | **owner only** (route gate `users.manage`; needs `x-branch-id`) | Records the registration for an active staff member. The number is stored trimmed and upper-case (letters, digits, `/`, `-`, up to 32). The date may be today but not past, and at most 10 years ahead. A renewal revokes the registration it replaces in the same transaction; sending the current values again changes nothing. |
| `POST /admin/pharmacist-registrations/:registrationId/revoke` `{ reason }` | owner only | Revokes it. Revoking again is a no-op. |

Refusals carry `code`: `PHARMACIST_REGISTRATION_OWNER_ONLY` (403) and `SLMC_NUMBER_IN_USE` (409:
another staff member's current registration has this number). Authority is read live, and again
after the staff member's membership or the registration row is locked. Each change and its audit
event (`pharmacist_registration.recorded` / `.revoked`) commit together. Registrations are retained:
content is immutable, revocation is recorded once, nothing is deleted, and a membership with
registrations on record cannot be deleted.

**The clinical check.** A signed command with a clinical effect passes only if the signed session's
staff member (`session.staffUserId`) has a current registration and an active account assigned to
the command's branch. "Current" means unrevoked and not past `expiresOn` in the branch's timezone.
Otherwise the command is refused with `PHARMACIST_REQUIRED`. The registration is share-locked: a
revocation that commits first is seen, and a later one waits for the clinical transaction; a
renewal that commits during the wait is found by one fresh read, so it is not refused. The
registration relied on is returned and copied into the command provenance
(`pharmacistRegistrationId`) for the operation's success audit. A signed prescription may instead
carry a registered pharmacist's PIN co-sign (`pharmacistEvidenceId`, "Pharmacist co-sign" above);
then the co-signer's registration is the one checked and recorded, and the co-signer is recorded
as `pharmacistUserId`. A co-sign on any other operation is `INVALID_COMMAND`. The check is
`PharmacistRegistrationService.assertQualified`; checkout calls it too.

**Controlled checkout.** `POST /sales/checkout` with controlled lines checks the dispenser's
registration with the same `assertQualified`, on the checkout's own transaction before any batch
is locked, so a revocation that commits first refuses the sale and a later one waits for it.

- **A PIN co-sign** (`pharmacistApproval`) names the dispenser, whoever is selling. The PIN is
  verified first, outside the transaction, so a wrong one counts towards the lockout; then the
  co-signer's registration. Without a current one the sale is refused with 403
  `APPROVER_NOT_QUALIFIED`, and the message names the co-signer. `sales.approve_controlled` is
  still needed as well.
- **A seller dispensing alone** (no co-sign) needs `sales.approve_controlled` at the branch, the
  permission a co-signer needs, resolved from the tenant's grants (owner, manager and pharmacist by
  default); without it the refusal is 403 `PHARMACIST_APPROVAL_REQUIRED`. They also need their own
  current registration on **every** checkout, at a counter or on the web POS, whatever the
  branch's desktop POS state. Without one the sale is refused with 403 `SELLER_NOT_QUALIFIED`,
  telling them to get a co-sign; the web POS opens its pharmacist PIN dialog on it.
- **Provenance.** The registration relied on is stored with the sale as
  `sale.dispenser_registration_id` (`dispenserRegistrationId` in sale responses), in the same
  transaction; a composite foreign key pins it to `dispensed_by` in the tenant. `sale.posted` and
  `sale.pharmacist_approved` audits carry `pharmacistRegistrationId` and `slmcNumber`.
- **Who is offered.** `GET /sales/pos/approvers` lists only approvers the check would accept now:
  current registration, active account and membership, a role at the branch, from the same rules
  as `assertQualified` (`PharmacistRegistrationService.qualifiedAt`). The read takes no lock;
  checkout checks again. Refund approvers (`GET /sales/pos/refund-approvers`) are not
  filtered: a refund is not clinical.

## Sales lifecycle (pilot)

- **Checkout**: `POST /api/v1/sales/checkout` — optional `Idempotency-Key`. Line **tax**: send `taxAmount` per line, or omit to apply **VAT** from server config (see below).
- **Void** (posted → voided, stock restored; elevated roles): `POST /api/v1/sales/:id/void`
- **Refund** (posted → refunded / partially_refunded): `POST /api/v1/sales/:id/refund` — needs `sales.refund`, plus `sales.approve_controlled` when the sale has controlled or prescription items. This is the only way to raise a customer return: `POST /returns` refuses `type: "customer"`, and completing a customer return left open on the old Returns page is refused too (cancel it and refund the sale instead).
  - Each line may carry `disposition: "restock" | "quarantine"`. Omitted, controlled and prescription items are held and the rest restock. Held lines are booked back in and quarantined in the same transaction (`reasonCode: "inspection"`), and the choice is stored on the return line.
  - Over `TenantSettings.approvalRequiredReturnThreshold`, the refund needs `returns.approve`: the caller alone if their role may approve its own requests, otherwise **403** with `code: "REFUND_APPROVAL_REQUIRED"` (`amount`, `threshold`) until the body carries `approval: { approverUserId, pin }` — another person's till PIN (or password if they have none), checked against `returns.approve` at the branch. The approver is recorded as the return's `approvedBy`.
  - **Why**: `reasonCode` is one of `wrong_item`, `changed_mind`, `damaged`, `expired`, `adverse_reaction`, `other` (stored on the return as `reason_code`); `other` needs a `reason` note. Callers that send no code must send `reason`.
  - **How the money goes back**: omit `refundMethod` and the refund goes back the way the sale was paid — card first, then mobile wallet, then credit, then cash (cash net of change given), with anything left over in cash. One `SalePayment` row per method, referenced `POS refund <returnNumber>`. Send `refundMethod` to put the whole refund on one method.
  - **Prepared remotely, executed at the counter (P6, D10).** `POST /sales/:id/refund-requests`
    (`sales.refund`, same body as a refund without `approval`) prices the lines against the sale's
    remaining returnable quantity and stores an immutable request (`RFR-…`) — no stock or money
    moves. One open request per sale (**409** otherwise). At or over the threshold it needs
    `POST /sales/refund-requests/:id/approve` (`returns.approve`, body `{ approvalId,
    expectedVersion, expectedDigest }` from the request's `approvalReview`; self-approval rules
    apply, and a preparer who may approve their own requests approves on preparation).
    `POST /sales/refund-requests/:id/cancel` (requester or approver) withdraws it. The counter runs
    `POST /sales/refund-requests/:id/execute` (`sales.refund`, body `{ approvalId }` = the
    displayed `executionApprovalId` or `null`, `Idempotency-Key` scope `sale_refund_execute`), or
    the signed operation above: it locks the sale, re-checks the original-sale limit and price
    (**400**/**409** if the sale changed), the live approval and controlled-item authority, then
    applies the same refund as the till, exactly once. Under the threshold nobody approved it, so the
    goods return's `approvedBy` is `null` and the `sale.refunded` audit carries `approvalWaived: true`. `GET /sales/refund-requests?saleId=&status=`
    and `GET /sales/refund-requests/:id` (`sales.refund`) return `status`, `readyAtCounter`,
    `approvalRequired`, `approvalReview` and requester/approver/executor.
  - **Pending refund approvals (W4/W11).** Sales → Pending approvals consumes the shared
    `GET /dashboard/work?kind=sale_refund.approve&filter=all&page=1&pageSize=25&q=` projection,
    including self-approval blockers. `filter=approvals` instead counts/returns only decisions
    the caller may make. `kind` accepts the shared `DAILY_WORK_KINDS` registry, `pageSize` is
    optional (default 6, maximum 100), and `q` (maximum 100 characters) searches task reference,
    detail and title case-insensitively as literal text. Each option only narrows the existing
    tenant/branch/source-permission scope. Module pending lists use the same source predicates,
    ordering and snapshot-based list/count/facet query as Daily work; no second inbox SQL/store.
    Internal notification kind allowlists intersect client kind filters. Task search/kind scope
    applies before category facets, totals and paging; existing requests without new fields keep
    their behavior. This is still an active-branch API, not the planned cross-branch overview.
    Refund tasks link to `/sales?view=pending-approvals&request=<id>`. The old `/refund-approvals`
    web route redirects there for draft-MR bookmarks; there is no separate sidebar destination.
    `GET /sales/refund-requests/:id` admits `sales.refund` **or** `returns.approve`, so an
    approver need not have sale execution/history permissions. Detail includes exact approval
    evidence, priced lines and nullable `productName`/`batchNo` display labels (outside the digest).
    The existing approval command and separate counter execution boundary are unchanged.
    Revoked/missing pinned evidence returns open refunds to pending review even if the threshold
    is later switched off; notifications use the same task model and omit self-blocked decisions.
    See `DAILY_WORK_QUEUE_PLAN.md` and W11 #145 for phased cross-app enhancement ownership.
  - **The desktop Returns page** prepares at the counter too: a PIN-opened counter login may call
    `POST /sales/:id/refund-requests` (`@CounterRoute()`), then executes the request through the
    signed operation when it is `readyAtCounter`. Over the threshold, a cashier's request waits
    for approval on the web and then appears under the page's "From web" tab.
  - `GET /api/v1/sales/:id/returnable` (`sales.pos_use`, counter route) lists each sale line's
    `soldQty` and `remainingQty` after earlier refunds, with `isControlled`,
    `requiresPrescription`, `batchNo`, `expiryDate`, `unit` and `refundUnitPrice`; plus
    `refundApprovalThreshold` (the tenant's limit, or `null`) and `refunds` (earlier completed
    refunds of the sale: `returnNumber`, `amount`, `createdAt`).
  - Refunds and voids of one sale now take a row lock on the sale, so two counters (or a till
    refund and a prepared one) can never refund the same units twice.
  - `GET /api/v1/sales/refunds` (`sales.refund`) lists the branch's customer returns, newest first, with `reasonCode` and `refundedTo: [{ method, amount }]`; `GET /api/v1/sales/pos/refund-approvers` lists who can approve one at the till.
- **The sale as the till gets it**: checkout, void, refund, `GET /sales/pos/by-invoice`, `GET /sales` and `GET /sales/:id` answer with the same shape. Each item has its own columns plus `product: { id, name, sku, unit }` and `batch: { id, batchNo, expiryDate }`, and never the batch's cost or selling price, whatever the caller holds. Historical cost is unavailable until sales store a sale-time cost snapshot.

### Approver co-sign: discounts and refunds over the limit (P2b #103)

One shape, shared by a line discount over the tenant's `posMaxDiscountPercent` and a prepared
refund over `approvalRequiredReturnThreshold`. Someone with the authority approves **on another
person's session, on the same counter**, by choosing their name and entering their own till PIN,
the way the pharmacist co-sign works:

```json
{ "approverUserId": "<uuid>", "pin": "<their till PIN, or their login password if they have none>" }
```

- **Who can co-sign.** `GET /sales/pos/discount-approvers` (`sales.pos_use`) lists people with
  `sales.discount_override` at the branch; `GET /sales/pos/refund-approvers` (`sales.refund`)
  people with `returns.approve`. Each row is `{ id, fullName, email, hasPosPin, roles }`. Both
  are `@CounterRoute()`s. The picker should leave out the signed-in person.
- **Checked on the server, live.** The PIN is checked first, outside the transaction, with the
  same lockout as the pharmacist co-sign (5 wrong, 15 minutes, switched off at the third lock;
  `APPROVER_PIN_INCORRECT` / `_LOCKED` / `_SWITCHED_OFF`, all **403**). The approver's membership,
  branch roles and grants are then read from the database inside the transaction
  (`AccessService.resolveApprovalAuthority`), not from a token or the permission cache: without
  the permission now, **403** `APPROVER_NOT_AUTHORISED`. The limit and threshold are read from
  `TenantSettings` on every request, never taken from the client.
- **Which co-sign was refused.** Every refusal from the co-sign itself (`APPROVER_PIN_*`,
  `APPROVER_NOT_AUTHORISED`, `APPROVER_IS_SELF`, and the "can't approve this" 403) carries
  `coSign: "discount" | "refund"`, because a checkout can carry a pharmacist's co-sign and a
  manager's, and both refuse a wrong PIN with the same code.
- **Not yourself.** A co-sign naming the signed-in user is **403** `APPROVER_IS_SELF`. Approving
  your own work goes through your own authority and the self-approval rule
  (`selfApprovalRoleKeys`), which is unchanged — including for the co-signer: a manager who
  prepared a refund and may not approve their own can't co-sign it on someone else's session.
- **Both people recorded** (revised D10): the seller or refunder stays the actor of their sale or
  refund, and the approver is recorded beside them.
- **Online only.** No signed or offline counter command carries a co-sign, and the desktop
  disables both while offline. The PIN is compared and dropped: it is not logged, audited or kept
  with the request (`sale.pharmacist_pin_failed` records the attempt count and the permission,
  never the secret).

**Discounts at checkout** (`POST /sales/checkout`). `GET /sales/pos/catalog` returns the
limit as `maxDiscountPercent` beside `vatRatePercent`, for display only. Each line's `discountAmount` must be between
zero and `unitPrice × qty` (**400**), for everyone. A line's discount percent is
`discountAmount ÷ (unitPrice × qty) × 100`. Up to `posMaxDiscountPercent` (default 10) anyone
selling may give it. Above it, `sales.discount_override` approves (owners and managers by default;
it used to be a hardcoded owner/manager check, and a migration grants it to those built-in roles):

- the seller, when they hold it and their role may approve its own requests; otherwise
- **403** `code: "DISCOUNT_APPROVAL_REQUIRED"`, with `limitPercent` and `maxPercent` (the highest
  line, to two decimals), until the body carries `discountApproval: { approverUserId, pin }`.

Within the limit `discountApproval` is ignored and not verified. Over it the sale stores
`discountApprovedBy` (the self-approving seller or the co-signer; `null` within the limit) beside
`soldBy`, the response carries `discountApprover: { id, fullName }`, and the transaction writes a
`sale.discount_approved` audit with the approver as actor and `{ soldByUserId, approvedByUserId,
coSigned, limitPercent, maxLinePercent, discountTotal, workSessionId }`.

**Refunds** (`POST /sales/refund-requests/:id/approve`). The route now accepts `sales.refund` as
well as `returns.approve`, and the body takes an optional `coSign` beside the review pin:

```json
{ "approvalId": "<uuid>", "expectedVersion": 1, "expectedDigest": "<64 hex>",
  "coSign": { "approverUserId": "<uuid>", "pin": "…" } }
```

Without `coSign` nothing changes: the signed-in user approves and needs `returns.approve` (else
**403** `PERMISSION_DENIED`). With it, the signed-in person needs `sales.refund`, the co-signer
needs `returns.approve` (live), and the exact-approval evidence (`ManagementApproval`), the
request's `approver` and the `sale.refund_approved` / `management_approval.issued` audits are the
co-signer's, with `coSignedOnSessionOfUserId` naming the signed-in person. Execution is unchanged:
the counter then runs `execute` with the returned `executionApprovalId`, and requester, approver
and executor stay separate. The route is a `@CounterRoute()`. A refund over the threshold executed
with no approval is still refused with `APPROVAL_REQUIRED`. The till refund
(`POST /sales/:id/refund`, `approval: { approverUserId, pin }`) keeps its own co-sign as before.

**Reading sales back (back office)** — all three need `sales.view` and no `x-branch-id` header; they cover the branches where the caller holds `sales.view` (every active branch for an owner), never the whole tenant. `SaleReadService` (`sales/sale-read.service.ts`) is the one read path: the till's recall, invoice lookup and typeahead (`/sales/pos/*`) and global search use it too.

- `GET /api/v1/sales/history` — newest first, paged on the server: `page` (from 1), `pageSize` (default 25, max 100), `branchId` (a branch id or `all`; omitted means the header's branch, or every viewable branch without one), `from` / `to` (tenant calendar days, `YYYY-MM-DD`, inclusive), `soldBy` (user id), `paymentMethod` (`cash`, `card`, `mobile_wallet`, `credit` — refund rows don't count), `invoiceNo` (contains, spaces ignored), `customerPhone` (part of the customer's phone; only digits count, and a leading `0` or `+94` is ignored, so `071 482 0937` and `+94714820937` find the same customer; at least 4 digits), `minTotal` / `maxTotal` (sale total, inclusive). Each row carries `customerPhone`. Returns `{ items, total, page, pageSize }`. A `branchId` the caller can't view is **403**.
  The desktop Returns page calls it from a PIN-opened counter login (`@CounterRoute()`), pinned to that counter's branch, to find a sale without the receipt.
- `GET /api/v1/sales/history/options` — `{ branches, sellers }` for the filters.
- `GET /api/v1/sales/history/:id` — items with batch, payments (refunds are negative rows), customer, prescription, seller, dispenser and completed refunds. `unitCost` and `costTotal` are currently `null` for every caller: sales do not store a sale-time cost snapshot, and the current batch cost cannot establish historical COGS. A sale outside the caller's branches is **404**.

**Controlled products** (`Product.isControlled`): checkout requires **pharmacist**, **manager**, or **owner** effective on the branch (owners may be recognized tenant-wide per service rules).

## Approval thresholds (server-enforced)

Configured in Settings → Approval Rules and stored on `TenantSettings`. **The server decides — a request cannot opt out.** Purchase-order approval used to follow a client-supplied `submitForApproval` flag, which made the configured ceiling advisory; `common/approval-threshold.util.ts` is now the single place the comparison happens.

| Setting                                  | Applies to                            | Effect when tripped                                              |
| ---------------------------------------- | ------------------------------------- | ---------------------------------------------------------------- |
| `approvalRequiredPurchaseOrderThreshold` | `POST /purchasing/purchase-orders`    | Created as `pending_approval` regardless of `submitForApproval`.  |
| `approvalRequiredReturnThreshold`        | Customer returns (create and submit)  | The owner/manager auto-approve shortcut is closed off.            |
| `approvalRequiredForBranchTransfers`     | `POST /transfers`                     | `false` skips approval entirely; `true` keeps the existing rule.  |

**Semantics**

- Document value is `(qty × unit − discount) + tax`, plus shipping for a PO — the same basis the order screen displays, so the threshold fires on the number the user saw.
- Comparison is `>=`: a threshold of `50000` catches an order of exactly 50,000. `null` means off; `0` legitimately means "approve everything".
- The rule is **role-blind**. Approval authority is already a separate permission (`purchasing.approve`, `returns.approve`, `transfers.approve`), so a held document is only clearable by someone who holds it — no second role carve-out is needed, and adding one would reopen the bypass.
- Return thresholds cover **customer** returns only, matching the setting's own wording; supplier returns follow the supplier workflow.
- `purchase_order.created` audit payloads carry `orderValue` and `approvalForcedByThreshold`, so a reviewer can tell a threshold trip from a voluntary submission.

### Approving your own requests

`TenantSettings.selfApprovalRoleKeys` (Settings → Approval Rules; `PATCH /tenant/settings/approvals`, role list from `GET /tenant/settings/approval-roles`) lists the `Role.key`s whose holders may approve a document they raised. Default `["owner", "manager"]`. Unknown keys are rejected with **400**.

| Document | "Raised by" | Where it's checked |
| --- | --- | --- |
| Purchase order | `createdBy` | `POST /purchasing/purchase-orders/:id/approve` |
| Transfer | `requestedBy` | `POST /transfers/:id/approve`; also decides whether a new transfer is approved on creation |
| Return | `requestedBy` | `POST /returns/:id/approve`; also decides the submit/create auto-approve |
| Stocktake | creator and everyone who entered a count | `POST /stocktakes/:id/review/start`, `PATCH /stocktakes/:id/review-lines`, `POST /stocktakes/:id/request-recount` and `POST /stocktakes/:id/approve` — the reviewer is the approver, so a counter can't review their own count either |

**Transfer approval, dispatch and receipt are separate (P6).** `GET /transfers/:id` returns
`approvalReview: { expectedVersion, expectedDigest }` to the source branch while the transfer is
requested/approved, `executionApprovalId`, `approvalWaived`, `dispatcher`, `dispatchedQty`,
`receivedQty` and `inTransitQty` (dispatched − received). `POST /transfers/:id/approve` takes
`{ approvalId, expectedVersion, expectedDigest }`, issues exact `transfer.ship` evidence and
reserves stock — no on-hand movement. Re-approving an approved transfer (revoked evidence,
pre-P6 approval) issues new evidence without reserving again. `POST /transfers/:id/ship` takes
`{ approvalId }` (the displayed `executionApprovalId`, `null` when waived) and **409**s on any
other; it consumes the reservation, issues `transfer_out` and sets `in_transit` with
`dispatchedBy/At`. `POST /transfers/:id/receive` accepts an optional `dispatchApprovalId` pin
beside `lines`, and requires live `transfers.manage` at the destination. Each line may carry
`receivedQtyBefore` (the `receivedQty` the screen showed); a receipt counted against an older
figure is **409**, so two partial receives of the same arrival can't both post. The web sends it. Both keep their
`Idempotency-Key` scopes; distinct concurrent dispatches move stock once. Approval created on
submit (self-approval) records the same exact evidence.

**Stocktake approval and posting are separate.** Approval binds the displayed material revision/digest to immutable evidence and leaves stock unchanged in `approved`. `POST /stocktakes/:id/post` applies stock/quarantine and completes the count with live approval checks and atomic audit. Legacy `/complete` closes already-posted records only; see the [P1 stocktake integration guide](POS_P1_IMPLEMENTATION.md) for inputs and recovery.

Approving your own request without the setting returns **403** ("You raised this …"). Approving someone else's needs only the approve permission. Self-approvals are marked `selfApproved: true` in the audit payload.

## Inventory and stock quantities

Stock changes only through the stock service, under a row lock; every endpoint that moves stock refuses a change that would take more than is available (**400**, "Only N available on batch …").

| Field | Meaning |
| --- | --- |
| `qtyOnHand` | Every unit physically at the branch, held or not |
| `quarantinedQty` | Held back from sale and transfer |
| `reservedQty` | Promised to an approved transfer that hasn't shipped |
| `availableQty` | Can be sold or transferred now: on hand − quarantined − reserved, and `0` for expired or unconfirmed-expiry batches |

Stock status (`ok` / `low` / `out`) is computed from **available**.

| Endpoint | Permission | Notes |
| --- | --- | --- |
| `GET /inventory/stock-by-product` | `inventory.view` | Adds `availableQty`, `quarantinedQty`, `reservedQty`, `expiredQty`, `expiredBatchCount`, `expiryReviewBatchCount`, and `nextExpiry` (earliest in-date expiry with stock, `YYYY-MM-DD`). The response carries `expiryWarningDays`, the window `near_expiry` counted against. New query: `attention=expired\|near_expiry\|quarantined\|reserved\|expiry_review`, `prescription=true`, `sort=name\|available\|onHand`, `dir=asc\|desc`. Each `product` includes `requiresPrescription`, `manufacturer`, `unitsPerPack` and `packLabel`. Counter route (the desktop Stock page). |
| `GET /inventory/batches` | `inventory.view` | Per-batch quantities as above; `q` searches batch no / product / SKU. `costPrice` is **null** without `costs.view`. |
| `GET /inventory/products/:productId/stock` | `inventory.view` | Totals, batches, reservations, incoming transfers, open PO quantity, other branches (branches the caller works at; owners see all), recent movements. Counter route (the desktop Stock page), but a PIN-opened counter login always gets `otherBranches: []`: the counter shows other branches as bands from `branch-availability` instead, so no other branch's quantities reach it. Password logins (the web) are unchanged. |
| `GET /inventory/products/:productId/branch-availability` | `inventory.view_other_branches_availability` | The counter's "Other branches" (decided 2026-11-05). Every other **active** branch of the tenant, whether or not the caller works there: `{ productId, controlled, branches: [{ branchId, name, band }] }`, sorted by name. `band` is `in_stock`, `low` or `out`, by `stock-by-product`'s rule (sellable available — in date, confirmed expiry, not held or reserved — against the product's `reorderLevel`). A controlled product gets `ask_pharmacist` for every branch, and its stock isn't read at all. No quantities, costs or batches are returned. The permission is on by default for owner, manager, pharmacist and cashier (migration `20261105400000_other_branch_availability` grants it to existing built-in roles); without it the route is **403**. Counter route. 404 for a product outside the tenant. |
| `GET /inventory/summary` | `inventory.view` | Adds `availableUnits`, `quarantinedUnits`, `reservedUnits`, `expiredUnits`, `expiryReview`, `incomingTransfers`. `stockValue` is **null** without `costs.view`. |
| `GET /inventory/movements` | `inventory.view` | Filters `productId`, `batchId`, `category` (adds `stocktakes`, `opening`, `quarantine`), `userId`, `from`/`to` (tenant-local dates), `referenceType`/`referenceId`. Quarantine moves appear once with `qtyDelta: 0` and a signed `quarantineDelta`; legacy reservation rows are hidden. `balanceAvailable` says whether before/after balances are meaningful (one product or batch, no other filters). |
| `GET /inventory/movement-actors` | `inventory.view` | Users who moved stock at the branch in the last year. |
| `POST /inventory/batches/:id/quarantine` | `inventory.quarantine` | Body `{ qty?, reasonCode: expired\|damaged\|recall\|inspection\|other, reason? }`. `qty` defaults to everything not already held or reserved; `reason` required for `other`. |
| `POST /inventory/batches/:id/release-quarantine` | `inventory.release_quarantine` | Body `{ qty?, reason? }`. Refused for expired batches. |
| `POST /inventory/quarantine-expired` | `inventory.manage_bulk` | Holds every sellable unit on expired batches. Returns `{ quarantined, units, batchIds }`. |
| `POST /inventory/adjustments` | `inventory.manage` (increase) or `inventory.write_off` (decrease) | Counter work (`stock`): posts now or not at all, returning `{ held: false, ok, referenceId, batchId }`. Body `{ kind, productId, batchId \| newBatch, qty, reason? }`. `kind` says what happened: `found`, `opening` (in), `damaged`, `expired`, `lost` (out), `correction` (either way — send `movementType`, and a `reason`). Damaged and expired units come out of quarantine first. A decrease that needs approval — the caller lacks `inventory.write_off`, or its value reaches `TenantSettings.approvalRequiredWriteOffThreshold` and the caller's role may not approve its own requests — is refused with **409 `WRITE_OFF_APPROVAL_REQUIRED`** before anything moves; nothing is held. Send it to `adjustment-requests`. Authority and the policy are read live, and again after the batch lock. Callers without `kind` keep the old shape (`movementType`, `reason` for decreases, `fromQuarantine`). Accepts `Idempotency-Key` (scope `stock_adjustment`): the key, the movement and its `inventory.adjustment` audit commit together, and a resend of the same body at the same branch returns the first `{ held: false, ok, referenceId, batchId }` and moves nothing. The key with any other body, or at another branch, is **400** "Idempotency-Key already used for a different stock adjustment". Identical requests sent together serialize on the key, so stock moves once. A refused or failed attempt (including the 409) leaves the key unused. The web sends one key per adjustment as entered, distinct from the key it sends the same entry to `adjustment-requests` under. Also a signed terminal command (below), which replays through its command receipt instead. |
| `POST /inventory/adjustment-requests` | `inventory.manage` or `inventory.write_off` | Remote (`management`). The same body, for a decrease only (`newBatch` and increases are refused). Records a held write-off and moves no stock, whoever sends it: `{ held: true, heldAdjustment, notified }`. Accepts `Idempotency-Key` (scope `held_adjustment_request`): a resend of the same body at the same branch returns the first request's `heldAdjustment` with `notified: 0` (nobody is told twice), and the key with any other body is **400** "Idempotency-Key already used for a different write-off request". Identical requests sent together serialize on the key, so one is held. The web sends one key per write-off as entered. The request and its `inventory.write_off_held` audit commit together; people with `inventory.write_off` are notified after commit. Accept and post it through `held-adjustments/:id/*`. |
| `GET /inventory/held-adjustments` | `inventory.view` | Awaiting/approved write-offs at the branch: kind, qty, `value` (**null** without `costs.view`), note, product, batch, requester, `approvalReview: { expectedVersion, expectedDigest }`, `executionApprovalId` and execution stamps. |
| `POST /inventory/held-adjustments/:id/accept` | `inventory.write_off` | Requires `{ approvalId, expectedVersion, expectedDigest }` from the displayed preview. Records exact approval only, sets `approved`, and leaves stock unchanged. Existing self-approval rules apply. The stable approval UUID makes identical retries safe; a fresh UUID explicitly replaces unusable evidence. |
| `POST /inventory/held-adjustments/:id/post` | `inventory.write_off` | Body `{ approvalId }` pins the displayed approval. Posts the saved adjustment in the same transaction as reference/status/audit, after current executor/approver and exact-material checks under locks. Repeats return the original posted record. Insufficient stock leaves the approval intact for review. |
| `POST /inventory/held-adjustments/:id/reject` | `inventory.write_off` | Body `{ reason }`. Nothing moves; the requester is told why. |
| `GET /inventory/write-offs/policy` | `inventory.view` | `{ threshold }` — the write-off limit (decimal string, or null when off), so the form can say before posting that a write-off will wait. Counter route. |
| `GET /inventory/write-offs/summary` | `inventory.view` | This month's decreases at the branch by kind: `{ since, rows: [{ kind, label, units, value }] }`. |

`POST /inventory/customer-returns` and `POST /inventory/supplier-returns` (which answered 410) have been removed, with the `inventory.customer_returns` permission. Customer returns are POS refunds; `POST /returns` is for supplier returns.

**Supplier invoices are recorded only through the ledger** (`POST /purchasing/invoices`, against the deliveries they bill). `POST /suppliers/:id/invoices`, which recorded a bare total with no lines and no delivery, has been removed: it skipped the three-way match and left the delivery's placeholder standing, so the same goods could be owed twice. Invoices it already created have `source: "supplier"` and no `deliveries`, and the web marks them "No delivery linked".

`GET /returns/goods-receipts/:id/returnable` (`returns.create`) lists, per batch on a delivery, what it brought in (`delivered` = paid + free + damaged), `damaged`, `alreadyReturned` (supplier returns against it that aren't cancelled or rejected), `onHand`, and `returnable` = the lesser of what's left and what's on hand; `unitCost` follows `costs.view`. A supplier return with a `goodsReceiptId` is refused (**400**) for a batch that didn't arrive on that delivery, or for more than it brought in less what has already gone back.

**Supplier return approval and dispatch (P6).** `POST /returns/:id/approve` (`returns.approve`) now takes `{ approvalId, expectedVersion, expectedDigest }` from the return's `approvalReview` and records exact `goods_return.complete` evidence of its lines, batches, quantities and prices; it moves a pending return to `awaiting_logistics` and changes no stock and no supplier balance. An approved return whose evidence is missing (approved before exact approvals) or no longer matches has `executionApprovalId: null` and can be approved again from `awaiting_logistics`/`in_review`. An approver who may approve their own returns still submits and approves in one step (`create` with `submit: true`, or `submit`); the evidence is recorded in the same transaction. `POST /returns/:id/complete` (`returns.process`, physical) takes `{ approvalId }`, which must be the return's latest approval (**409** otherwise); it rechecks the approval under the return lock and the approver/executor rights after the batch locks, then issues the stock (quarantined units first), raises the debit note and completes, with one audit carrying requester, approver and executor. Repeats return the completed return; the optional `Idempotency-Key` is unchanged. It is also a signed terminal command. Return responses add `approvalReview`, `executionApprovalId`, `approvalApprovedBy` and `approvalApprovedAt`.

**Goods receipt** (`POST /purchasing/purchase-orders/receive`) now refuses a received date in the future and any line whose expiry is on or before the received date. Auto-created supplier invoice numbers include the branch code (`SINV-<BRANCH>-<seq>`) so each branch's first delivery no longer collides.

## Purchasing: packs, deliveries and prices

Quantities on the wire are always **units**; packs are a way of entering them. A purchase order line accepts `orderedPacks` (+ optional `unitsPerPack`) or `orderedQty`, and `packCost` or `unitCost`. Packs win when both are sent, and the pack used is stored on the line so a later product edit can't restate the order. Omitting the cost falls back to the supplier's price list, then to a **400** naming the product.

| Endpoint | Permission | Notes |
| --- | --- | --- |
| `GET /purchasing/purchase-orders` | `purchasing.view` | `unitCost`, `packCost` and `shippingCharges` are **null** without `costs.view`. |
| `GET /purchasing/purchase-orders/:id` | `purchasing.view` | Lines add `orderedPacks`, `unitsPerPack`, `packCost`, `receivedQty`, `freeQty`, `rejectedQty`, `outstandingQty`, `outstandingPacks`. `selfApprovalBlocked` is true when the caller raised the order and their role may not approve its own requests. |
| `POST /purchasing/purchase-orders/:id/hold-delivery` | `purchasing.receive` | Body `{ reasons: ("over_delivery" \| "price_variance")[], detail, delivery }`, where `delivery` is the receive body as typed. Saves it as a **held delivery** (`awaiting_approval`) — no stock, no ledger — and notifies the holders of `purchasing.approve` at this branch (owners always), excluding the caller, with a link to `/purchasing?po=…&held=…`. One held delivery per receiver per order: sending again replaces it, and re-notifies only for a new reason or after ten minutes (`alreadyAsked: true`). Returns `{ held, notified, alreadyAsked }`. |
| `GET /purchasing/held-deliveries` | `purchasing.view` | Default includes `awaiting_approval` and `approved`; an explicit status filters `awaiting_approval` \| `approved` \| `accepted` \| `rejected`. Typed costs are withheld without `costs.view`. Responses include `approvalReview`, `executionApprovalId`, `executedBy` and `executedAt`. `GET /purchasing/purchase-orders/:id` also returns the order's waiting ones as `heldDeliveries`. |
| `PATCH /purchasing/held-deliveries/:id` | `purchasing.approve` | Save `{ expectedVersion, expectedDigest, delivery, updateSupplierPrice? }` before approving corrections. The old preview includes the PO revision, so concurrent agreement changes reject. Original receiver input is retained; corrections become `preparedPayload`. Returns a fresh `approvalReview`; material changes invalidate prior evidence. Omitted optional header/line fields retain saved values, including supplier delivery note, exact costs and exception choices; the submitted line list determines included products. An omitted supplier-price choice retains its saved value; an explicit boolean changes it. Cost edits require `costs.view`. |
| `POST /purchasing/held-deliveries/:id/accept` | `purchasing.approve` | Requires `{ approvalId, expectedVersion, expectedDigest }`. Can approve the current saved document directly without PATCH or submitting redacted costs. Saves immutable approval for the exact delivery, PO revision and exception choices; no stock, receipt, supplier invoice or balance changes. Reuse the approval UUID for retry; use a new one for explicit reapproval. |
| `POST /purchasing/held-deliveries/:id/post` | `purchasing.receive` | Body `{ approvalId }` pins the displayed approval. Posts the approved saved delivery, accepting its scoped quantity/price exceptions through persisted approval rather than granting the executor approval permission. Current approver/executor rights are checked after locks. Stock, quarantine, GRN, supplier invoice/price updates, held status and audit commit together. Concurrent/repeated posts return the original receipt link. |
| `POST /purchasing/purchase-orders/:id/prepared-receipts` | `purchasing.manage` | **Remote preparation** of a delivery from the supplier's note. Body `{ delivery: { supplierDeliveryNote?, acceptOverDelivery?, acceptPriceVariance?, updateSupplierPrice?, lines }, notes? }` — the receive body without `purchaseOrderId` or `receivedOn`. Saves a `draft` prepared receipt; no stock, receipt, invoice or price change. Lines must be on the order, once each; costs need `costs.view`. One open (draft or approved) prepared receipt per order: **409** `RECEIPT_ALREADY_PREPARED`. Approvers at the branch are notified. |
| `GET /purchasing/prepared-receipts` | `purchasing.view` | Open (draft and approved) prepared receipts by default; `status` filters `draft` \| `approved` \| `posted` \| `cancelled`. Responses carry `approvalReview` (null once it can no longer be approved), `executionApprovalId`, `preparedBy`/`approvedBy`/`executedBy` with times, `orderOpen` and `selfApprovalBlocked`. Typed costs are withheld without `costs.view`. `GET /purchasing/purchase-orders/:id` also returns the order's open ones as `preparedReceipts`. |
| `PATCH /purchasing/prepared-receipts/:id` | `purchasing.manage` | Body `{ expectedVersion, delivery?, notes? }`. **409** unless `expectedVersion` is the current revision. A material change (any delivery field) advances the revision, clears the approval and returns the receipt to `draft`, even when a value is later restored; `notes` change metadata only and keep the approval. Without `costs.view`, saved costs are kept and typed costs refuse. |
| `POST /purchasing/prepared-receipts/:id/approve` | `purchasing.approve` | Body `{ approvalId, expectedVersion, expectedDigest }` from `approvalReview`. Records exact `prepared_receipt.post` evidence for the delivery, its exception choices, the order revision and what each order line had already received; status `approved`, nothing else changes. Self-approval follows the tenant setting. Reuse the approval UUID to retry; a new one replaces the approval. |
| `POST /purchasing/prepared-receipts/:id/post` | `purchasing.receive` | **Physical (counter).** Body `{ approvalId }` must be the displayed `executionApprovalId` (**409** otherwise). Books the delivery in through the normal receiving path, received on the branch's business date: tolerances, price variance, cost/expiry conflicts, damaged-unit quarantine, supplier price updates and the placeholder supplier invoice behave as for any delivery, with the approver's exceptions carried by the evidence. The approval is revalidated under the order lock (a delivery booked in between or an order edit is `APPROVAL_STALE`) and approver/executor rights again after batch-lock waits. Stock, GRN, invoice, status and audit (requester, approver, executor) commit together; repeats return the same receipt. While a prepared receipt is open (draft or approved), `purchase-orders/receive`, held-delivery posting and `hold-delivery` refuse with **400** `RECEIPT_PREPARED`, and preparing refuses with **409** `DELIVERY_AWAITING_APPROVAL` while a held delivery is waiting, so the same goods can never be booked in twice. Also a signed terminal command. |
| `POST /purchasing/prepared-receipts/:id/cancel` | `purchasing.manage` or `purchasing.approve` | Body `{ reason }`. Closes a draft or approved prepared receipt; nothing is booked in. |
| `POST /purchasing/held-deliveries/:id/reject` | `purchasing.approve` | Body `{ reason }`. Nothing is booked in; the receiver is notified with the reason. **409** once decided. |
| `GET /purchasing/deliveries` | `purchasing.view` | Goods receipts for the branch, newest first. Query `supplierId`, `from`, `to`, `q`. Per-delivery `paidUnits`, `freeUnits`, `rejectedUnits`, and `value` (null without `costs.view`). |
| `GET /purchasing/reorder-suggestions` | `purchasing.manage` | Products at or below their reorder level after subtracting **available** stock and everything already on order, grouped by the cheapest active supplier who lists them. `unassigned` holds those no supplier prices. |
| `POST /purchasing/purchase-orders/receive` | `purchasing.receive` | Lines accept `packs`/`receivedQty`, `freeQty`, `rejectedQty` (+ `rejectedReason`, required), `packCost`/`costPrice`, `sellingPrice`, `onCostConflict`. Body accepts `supplierDeliveryNote`, `acceptOverDelivery`, `acceptPriceVariance`, `updateSupplierPrice`. |
| `GET /purchasing/supplier-prices` | `costs.view` | Compact price map (`productId`, `unitCost`, `unitsPerPack`, `discountPercent`) for prefilling order lines. |
| `GET /purchasing/batch-lookup` | `purchasing.receive` or `inventory.view` | `productId` + `batchNo` → whether that batch is already on the shelf here, with its expiry, units on hand and whether its expiry is still unconfirmed. Cost is withheld without `costs.view`. |
| `GET /suppliers/:id/prices` | `suppliers.manage_prices` | The supplier's price list with `lastUnitCost` and `priceDrift` beside the agreed cost. |
| `PUT /suppliers/:id/prices` | `suppliers.manage_prices` | Upsert one product's price (`packCost` or `unitCost` required). |
| `DELETE /suppliers/:id/prices/:productId` | `suppliers.manage_prices` | Removes one product from the list. |

Held adjustments and deliveries keep `accepted` for successfully posted history; the new `approved` state awaits physical execution. Existing records are not given invented approval or executor evidence. Notes preserve approval; material edits advance revision even if restored. Approved deliveries continue blocking alternate receiving on the PO until posted/rejected. An authorized reviewer can issue fresh approval if previous evidence is revoked or its approver loses rights. There is no extra two-person rule or mandatory approval TTL. Notifications distinguish approval from posting.

Deploy API/web together for the new approval DTOs and actions. The action registry permits remote preparation/approval and marks posting as physical; actual enrolled-terminal/attendance cutover and signed original-result command receipts remain coordinated P1/P2/P6 work. Existing approval-optional direct workflows retain their current thresholds and permissions.

Two refusals from receiving carry a machine-readable `code` so a client can ask the user instead of failing:

| `code` | Status | Body | Meaning |
| --- | --- | --- | --- |
| `OVER_DELIVERY` | 400 | `overDeliveries[]` | More arrived than is outstanding, beyond `goodsReceiptOverTolerancePercent`. Retry with `acceptOverDelivery: true` as a caller holding `purchasing.approve`. |
| `EXPIRY_CONFLICT` | 400 | `expiryConflicts[]` | The batch number is on file with a different expiry. Retry with `onExpiryConflict: "use_existing"` per line, or `"correct_existing"` — which is accepted only for a batch still awaiting expiry review, and only from a caller holding `inventory.manage`. |
| `PO_NOT_OPEN` | 400 | `status` | The order is no longer open for receiving (fully received, short-closed, cancelled, not yet issued). Re-read the order. |
| `PRICE_VARIANCE` | 400 | `priceRises[]` | Billed above the agreed price by more than `purchasePriceVarianceTolerancePercent`. Retry with `acceptPriceVariance: true` (and optionally `updateSupplierPrice: true`) as a caller holding `purchasing.approve`. A price drop never triggers this. |
| `COST_CONFLICT` | 400 | `costConflicts[]` | A batch is already in stock at a different cost. Retry with `onCostConflict: "keep_existing" \| "update_cost"` per line. |

## Supplier invoices, payments and debit notes

| Endpoint | Permission | Notes |
| --- | --- | --- |
| `GET /purchasing/payables` | `purchasing.invoice` or `suppliers.pay` | Branch totals: `outstanding`, `overdue`, `awaitingInvoice` (+ count of deliveries still on a placeholder), `openCredits`. |
| `GET /purchasing/invoices` | `purchasing.invoice` or `suppliers.pay` | Query `supplierId`, `status` (`outstanding`, `overdue`, or an invoice status), `source` (`system` = delivery awaiting invoice), `from`, `to`, `q`. |
| `GET /purchasing/invoices/:id` | `purchasing.invoice` or `suppliers.pay` | Lines, deliveries, payments, debit notes and `match` — per-product ordered / received / billed with a `status` and `valueAtStake`. |
| `GET /purchasing/invoices/unbilled-deliveries` | `purchasing.invoice` | `supplierId` → deliveries no real invoice covers yet, with their billable lines. |
| `POST /purchasing/invoices` | `purchasing.invoice` | The supplier's invoice: `invoiceNumber`, `invoiceDate`, optional `dueDate` (else supplier terms), `receiptIds[]`, `lines[]` (`productId` or `description`, `qty`, `unitCost`), optional `taxAmount`, `shippingAmount`. Voids the placeholders of the linked deliveries and moves their allocations across. **409** if this supplier's number is already recorded. |
| `POST /purchasing/invoices/:id/void` | `purchasing.invoice` | `{ reason }`. Refused while payments or debit notes are set against it. |
| `GET /purchasing/payments` | `purchasing.invoice` or `suppliers.pay` | Query `supplierId`, `from`, `to`. |
| `POST /purchasing/payments` | `suppliers.pay` | `supplierId`, `paidOn`, `amount`, `method` (`bank_transfer`, `cheque`, `cash`, `card`, `other`), optional `reference`, `notes`, `allocations[]`. Without allocations the amount settles the oldest due first; either way the whole amount must land on open invoices (**400** "more than is owed"). Accepts `Idempotency-Key` (scope `supplier_payment`). |
| `POST /purchasing/payments/:id/void` | `suppliers.pay` | `{ reason }`. The row is kept and marked voided; the invoices it settled go back to owing. |
| `GET /purchasing/debit-notes` | `purchasing.invoice` or `suppliers.pay` | Raised automatically when a supplier return completes. |
| `POST /purchasing/debit-notes/:id/apply` | `suppliers.pay` | Optional `allocations[]`; otherwise the oldest open invoices first. A remainder stays open. |
| `POST /purchasing/debit-notes/:id/void` | `purchasing.invoice` | Refused once any of it has been applied. |

`POST /suppliers/invoices/:id/payments` (the supplier page) now records a ledger payment too, so it appears in the payment history and can be voided. Invoice numbers are unique **per supplier**.

Delivery lines report `orderedUnitCost` beside `unitCost` and a `variancePercent`, so what the price did between agreeing and being billed is answerable later without reading the order back.

All three refusals roll the whole delivery back: no units, no GRN, no invoice. Free units enter stock at no charge and lower the batch's effective cost; rejected units enter stock and are quarantined against the GRN; neither closes the ordered quantity. Receiving also refreshes the supplier's `lastUnitCost` for each line.

## Pricing / tax (Sri Lanka–oriented, configurable)

- **`PRICING_VAT_RATE_PERCENT`**: default `0`. When a checkout line omits `taxAmount`, VAT is computed as **exclusive** on `(unitPrice × qty − discountAmount)`, rounded half-up to 2 decimal places.
- Set to the statutory rate for your deployment when you want server-driven VAT without the client sending line tax.

### Currency: LKR only

`Tenant.currency` accepts **`LKR` and nothing else**, validated with `@IsIn(SUPPORTED_CURRENCIES)` on both `PATCH /tenant/profile` and the onboarding draft. `common/currency.constants.ts` is the single list.

The app has no shared currency formatter — the rupee symbol is a literal across roughly forty screens, receipts and reports. Onboarding previously offered seven currencies, so a tenant could select AED and then be shown, and print, rupees everywhere. Restricting the input was chosen over shipping that mismatch.

**Widening the list is the last step of multi-currency support, not the first.** Add a `formatCurrency` driven by `Tenant.currency`, remove the hardcoded literals, then extend `SUPPORTED_CURRENCIES` and `CURRENCY_OPTIONS` in the web app. `COUNTRY_OPTIONS` keeps its full list throughout — timezone and phone code are honoured for real; only currency is pinned.

## Customers and prescriptions

Two read paths per entity, deliberately different, because a counter picker and a management page want opposite things.

| Endpoint | Purpose |
| --- | --- |
| `GET /customers?q=` | POS picker. Capped at 50, **active only** — the till must never attach a retired profile to a new sale. |
| `GET /customers/directory` | Customers page. `q`, `status` (`all`/`active`/`inactive`), `page`, `pageSize` (max 100); returns `{ items, total, page, pageSize }` and includes deactivated records. |
| `GET /customers/:id/profile` | Profile plus purchase and prescription history, and lifetime-value stats. |
| `PATCH /customers/:id` | Partial update; `customers.manage`. |
| `GET /prescriptions?q=` | POS picker, branch-scoped, capped at 50. |
| `GET /prescriptions/register` | Prescriptions page. `q`, `validity` (`all`/`valid`/`expired`), `page`, `pageSize`. |
| `POST /prescriptions` | Record one presented at the counter; `prescriptions.create`. Classified `clinical`. Also a signed terminal command, which additionally needs the session's pharmacist to hold a current SLMC registration (see "Signed terminal commands"); the desktop uses only that. Unsigned, it is refused with 403 `PRESCRIPTION_AT_COUNTER` at a branch live on PharmaCeylon POS outside a fallback ("Unsigned prescription recording"). Both paths write a `prescription.recorded` audit. A number already used at the branch is 400. |

**Semantics**

- **Customer history spans branches; the prescription register does not.** Someone who fills a prescription at one shop and returns to another is the normal case, so `/:id/profile` is tenant-scoped. `Prescription.rxNumber` is unique per branch, so the register follows the `x-branch-id` header.
- Lifetime value counts **posted** sales only — a voided or refunded sale is not spend.
- **Who recorded it, and who checked it.** Every prescription in `GET /prescriptions`,
  `GET /prescriptions/register`, `GET /prescriptions/:id`, the `POST /prescriptions` response and
  the profile's prescription history carries `recordedBy: { id, fullName }` (who typed it in) and
  `checkedBy: { id, fullName, slmcNumber } | null`: the pharmacist whose SLMC registration the
  signed counter command relied on (the PIN co-signer, or the registered pharmacist recording it
  alone) and that registration's number. `checkedBy` is `null` for a prescription recorded through
  the unsigned browser route, which checks no registration. It is stored with the prescription at
  record time (`prescription.checked_by` / `checked_registration_id`, pinned to each other by a
  composite foreign key), and prescriptions recorded at a counter before it existed were filled
  from their `prescription.recorded` audit provenance.
- `validity=valid` includes prescriptions with `validUntil: null`, which never lapse. The cutoff is midnight UTC, so one expiring today still reads as valid.
- Deactivating a customer (`isActive: false`) hides them from the counter picker and keeps all history; there is no delete.
- `customers.manage` is separate from `customers.create` so counter staff can register a walk-in without being able to rewrite an existing profile. Defaults to owner, manager and pharmacist.

## Global search

- **`GET /api/v1/search?q=<term>&limit=5`** searches the active branch and tenant-scoped directories.
- Results are grouped by entity type and include deep-link metadata for products, invoices, customers, suppliers, purchase orders, transfers, and stocktakes.
- The API resolves the caller's effective branch permissions before querying each entity. A result from a domain the user cannot view is never fetched or returned.
- Exact identifiers/barcodes rank ahead of prefix and contains matches. `limit` applies per result group and is capped at 10.

## Notifications

All notification routes are authenticated and recipient-scoped. Branch-specific list/count calls honor `x-branch-id`; tenant-wide notices use a null branch and remain visible.

| HTTP        | Route                                | Purpose                                                                     |
| ----------- | ------------------------------------ | --------------------------------------------------------------------------- |
| `GET`       | `/api/v1/notifications`              | List active notices; supports `status`, `category`, `q`, `skip`, and `take` |
| `GET`       | `/api/v1/notifications/unread-count` | Lightweight unread badge count                                              |
| `PATCH`     | `/api/v1/notifications/:id/read`     | Mark one owned notice read                                                  |
| `PATCH`     | `/api/v1/notifications/read-all`     | Mark visible branch/global notices read                                     |
| `PATCH`     | `/api/v1/notifications/:id/archive`  | Archive one owned notice                                                    |
| `GET/PATCH` | `/api/v1/notifications/preferences`  | Read or update the caller's category preferences                            |

Operational alerts are durable, deduplicated projections. Header/page polling reconciles low-stock, expiry, purchase-order approval/overdue, transfer approval/receiving, and stocktake review/posting conditions at most once per user and branch every 20 seconds. When a condition clears, the notice is resolved instead of remaining as stale work.

Apply migration `20260829183000_add_notifications` before enabling these endpoints.

## Catalog work queue

Every catalog decision waiting on a person, in one durable list. Replaced the two screens whose
lists were recomputed on each request, which meant a dismissal could not be recorded.

| Route                                                               | Permission        | Notes                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /catalog-tasks`                                                | `products.view`   | Filters as comma-separated query params: `status`, `type`, plus `view` (`compliance`, `ambiguous`, `no_suggestion`, `safe`), `q`, `importId`, `source`, `createdFrom`, `createdTo`, `skip`, `take`. Unknown enum members are dropped rather than rejected, so a stale bookmark degrades to a broader list instead of a 400. Defaults to open work (`OPEN`, `NEEDS_REVIEW`). |
| `GET /catalog-tasks/summary`                                        | `products.view`   | Headline counts for the Manage-catalog badge and the Products issue banner.                                                                                                                                                                                                                                                                                                 |
| `POST /catalog-tasks/refresh`                                       | `products.manage` | Regenerates. Idempotent; never overwrites a `RESOLVED`, `DISMISSED`, or user-set `NOT_APPLICABLE` row. Optional `importId` scopes the pass to one import's products.                                                                                                                                                                                                        |
| `POST /catalog-tasks/apply-safe`                                    | `products.manage` | Takes the same filter body as the list, so the number applied is exactly the number the button offered. Excludes anything compliance-sensitive or ambiguous regardless of evidence.                                                                                                                                                                                         |
| `POST /catalog-tasks/:id/apply`                                     | `products.manage` | Optional `categoryId` / `referenceProductId` override the suggestion. NMRA tasks apply through the same link service as the product page.                                                                                                                                                                                                                                   |
| `POST /catalog-tasks/:id/dismiss` \| `/not-applicable` \| `/reopen` | `products.manage` | Terminal states survive `refresh`; `reopen` is the manual override for a wrong exclusion.                                                                                                                                                                                                                                                                                   |

## Reference catalog and range

| Route                                  | Permission        | Notes                                                                                                                                                                                                               |
| -------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /products/reference/preview-add` | `products.view`   | Dry run. Reports duplicate barcode/registration collisions and compliance differences per row.                                                                                                                      |
| `POST /products/reference/add`         | `products.manage` | Promotes NMRA reference rows into the range. Anything the preview flagged is **held back** unless `acknowledgeWarnings: true` — a client that forgets to show the review cannot silently create duplicate products. |
| `POST /products/range/exit`            | `products.manage` | "Stop selling". Per product the policy returns unrange (register-derived, no history), deactivate (locally created, or has history), or blocked (still holding stock), with a reason for each.                      |

`GET /products` additionally accepts `importId`, which scopes the list to one import run — this
is what the import completion screen's "View imported products" links to.

## Branch hours (W7 / D-W6)

Structured hours replace the free-text `Branch.openingHours`. The document is `BranchHours` in
`packages/shared/src/branch-hours.ts`, checked by `validateBranchHours` on both sides; P3 reads it
(and the active extensions) when it resolves a grant's `operatingWindows` /
`mandatoryOperatingWindows`. Every change applies to counters after their next sync.

| Route                                                         | Permission              | Notes |
| ------------------------------------------------------------- | ----------------------- | ----- |
| `GET /tenant/branches/:branchId/hours`                        | `tenant.branches_view`  | `BranchHoursView`: the document (or `null` if none yet), `origin`, `version`, the old free text as `legacyText`, and extensions that haven't ended or been revoked. |
| `PUT /tenant/branches/:branchId/hours`                        | `tenant.branches_manage` | Replaces the document. Needs `expectedVersion` (stale → 409 `HOURS_VERSION_CONFLICT`). Saving an empty mandatory list over anything else needs `confirmNoSelling: true` (else 400 `NO_SELLING_CONFIRMATION_REQUIRED`). |
| `GET /tenant/branches/:branchId/hours/holiday-suggestions`    | `tenant.branches_view`  | The rest of this year's and next year's verified public and poya holidays, to offer as dated exceptions. `years` says, per year, which gazette the list came from, or `source: null` when there is no verified list for that year yet (nothing is suggested for it). The 2026/2027 files are unregistered drafts pending comparison with their gazettes. Never applied by the server. Lists live in `apps/api/src/tenant/holidays` (see its README). |
| `POST /tenant/branches/:branchId/hours/extensions`            | `tenant.branches_manage` | Online business extension: `startsAt`, `endsAt` (at most 24 hours, not in the past, no overlap) and `reason`. The caller is the approver. |
| `POST /tenant/branches/:branchId/hours/extensions/:id/revoke` | `tenant.branches_manage` | Needs a `reason`. The row is kept; content is immutable and a revocation is recorded once (database trigger). |

- **Times** are branch-local `HH:MM`. A closing time earlier than the opening time runs past
  midnight; `24:00` is midnight at the end of the day. A range belongs to the day it opens on.
- **Mandatory** follows D8: `null` = no mandatory restriction, `[]` = no selling, otherwise
  selling only inside the listed weekly windows. It is `null` unless the owner sets it.
- **Who**: like `PATCH /tenant/branches/:branchId` — an owner on any branch, or the manager of
  this branch. Changing mandatory limits is owner-only (403 `MANDATORY_HOURS_OWNER_ONLY`).
- **Version**: `operatingHoursVersion` bumps on every change to the document or to extensions.
- **Migration** `20261027000000_structured_branch_hours` keeps `opening_hours` as it was and reads
  it into a document only when the text is unambiguous (`origin: "legacy_text"` until a person
  saves). It never writes a mandatory restriction, and the database refuses one with that origin.
- `openingHours` is no longer accepted by `POST /tenant/branches` or `PATCH /tenant/branches/:branchId`.

### Role back-office web access (W3)

Role list/create responses include `backOfficeAccess: boolean`. `POST /admin/roles` accepts
an optional boolean (new custom-role default false). `PATCH /admin/roles/:id/permissions`
accepts optional `backOfficeAccess` alongside `permissionKeys`; both save in the same database
transaction. Omission preserves the setting. The locked owner role rejects edits.
`GET /tenant/my-permissions` includes effective `backOfficeAccess`, resolved for only the
selected branch's role IDs and tenant, or all the caller's mappings without a branch header.
This field only scopes web presentation: operation permission keys and API checks remain intact.
Apply migration `20261028000000_role_back_office_access` before deploying API/web together.

## Counter alert settings (W7)

`GET /tenant/settings/counter-alerts` and `PUT` on the same path require `tenant.management`.
The tenant-wide version-1 document has one rule per counter alert type (`counter_offline`,
`permission_expiring`, `snapshot_stale`, `sync_failed`, `discrepancy_opened`, `incident_note`,
`device_lost`, `fallback_changed`): `{ type, enabled, recipientRoleKeys }`. Recipients are role
keys (built-in names or this tenant's custom role slugs); a switched-on alert needs at least one.
Null stored means every type on for owners and managers. Reads fill types added since a policy
was saved with their defaults and drop removed ones; saves are strict. A deleted custom role is
dropped from recipients on read rather than blocking its deletion, and GET lists in
`unreachableTypes` any switched-on alert left with no recipient, which a save then refuses until
someone is chosen or it is switched off. PUT takes `{ expectedVersion, policy }`; stale versions
return 409, a role deleted since loading 400 (naming it); the update and its audit
(`tenant_settings.counter_alerts_updated`) commit together. The open `GET /tenant/settings` no
longer returns these columns. Settings only: W9 #71 generates and delivers the alerts, to holders
of a recipient role at the alert's branch.

## Versioning

Pilot uses **`/api/v1`**. Breaking changes should move to `/api/v2` or be gated by explicit API version headers if you outgrow this model.

## Branch counter policy (W7)

`GET /tenant/branches/:branchId/counter-policy` and `PUT` on the same path require
`tenant.management` on the target branch. PUT accepts `{ expectedVersion, policy }`; version
conflicts return 409. The version-2 document configures online payment methods (cash is always
accepted), branch offline enablement, approved external-card provider/merchant identifiers and
per-register receipt/invoice prefixes; offline defaults to disabled. Stored version-1 documents
are read as version 2. GET also lists the branch's registers. Fixed offline rules cannot be
edited. Saving is not offline activation or grant renewal.

`GET /tenant/branches/:branchId/counter-settings` (`tenant.management` at the branch) is the
read-only grant settings source: every value settings contribute to an offline grant, with the
counter-policy and operating-hours versions P3 re-issues on. See [W7_COUNTER_POLICY.md](W7_COUNTER_POLICY.md)
for validation, atomic audit, live authority, examples and downstream integration boundaries.

## Offline authority issuance (P3)

A signed-in counter requests a command with
`POST /api/v1/terminals/offline-authority/challenge` and
`{ workSessionId, requestId }`. The counter signs the returned command and submits
`{ envelope, attendanceProofId }` to `POST /api/v1/terminals/offline-authority`.
The response contains the signed `grant` and `snapshot`. The API commits both
before returning them. After a lost response, request a fresh challenge and
attendance proof using the same `requestId` to recover the original pair.

- Only the branch's current offline counter (the D13 nomination) may ask: the challenge itself
  is refused with 403 `IDENTITY_MISMATCH` for any other enrollment, before an attendance proof is
  spent or anything is stored. The desktop then waits 15 minutes before asking again.
- The grant needs the branch's selling hours: unset hours or an unusable timezone are 403
  `BRANCH_HOURS_NOT_CONFIGURED`; stored hours that fail validation are `TEMPORARILY_UNAVAILABLE`.
  Offline selling off, or nobody prepared on the counter with `sales.pos_use`, is `GRANT_INVALID`.
- Snapshots and issued pairs are immutable evidence (a trigger refuses update and delete), tied
  to the enrollment they were issued to.

Issuance requires `OFFLINE_AUTHORITY_KEY_ID` and an Ed25519 PKCS#8 PEM in
`OFFLINE_AUTHORITY_PRIVATE_KEY` (a `\n`-escaped single line is accepted; see
`apps/api/.env.example`). The desktop verifies responses against an independently provisioned
server public key (`POS_OFFLINE_AUTHORITY_KEY_ID`, `POS_OFFLINE_AUTHORITY_PUBLIC_KEY`).

**Renewal.** The same request, with a new `requestId`, renews: every issuance is a new
immutable version (the grant's `grantVersion` equals the snapshot's `snapshotVersion`, counting
from 1 per enrollment), its grant expires 24 hours after this issuance, and earlier versions are
kept. A `requestId` that was already issued always replays its own version, however many
versions followed.

- **Journal baseline (the rebase, P5 #51).** The snapshot's `includedThroughSequence` /
  `includedThroughHash` are the enrollment's accepted offline journal head: the highest
  `terminal_command_receipt` with an `offline_sequence`, and its digest. They are read in the
  issuance's own repeatable-read view together with the stock the snapshot signs, so every posted
  offline sale through the head is already out of the balances. While nothing is accepted, the
  baseline is 0 / `null`. Batches with an open `batch_sale_block` at the branch (whichever
  counter's journal opened the case) are `stockReviewRequired`, which covers the sales still
  pending reconciliation. Online receipts (no `offline_sequence`) are not journal. A new request
  is 403 `RECONCILIATION_REQUIRED` only while the journal is stuck past its head on an entry that
  was rejected or conflicts with the accepted chain (an `offline_journal_review` row): nothing
  after it can be accepted until it is reviewed. This is refused at the challenge already,
  unless the `requestId` is a replay. Held entries (a gap, a sign-in not uploaded yet) don't
  refuse.
- **Replaced counters.** Only the current nomination is issued to, replays included. Issuance holds
  the nomination, enrollment and terminal rows (`FOR SHARE`) until it commits, so moving the
  nomination, revoking the enrollment or retiring the terminal either waits for it or makes it
  retry, and the retry is refused with `IDENTITY_MISMATCH`.
- **Concurrency.** Concurrent renewals with different `requestId`s get consecutive versions;
  identical ones get one issuance. A conflict that persists after retries is
  `TEMPORARILY_UNAVAILABLE`.

**Desktop cadence.** The nominated counter renews whenever its installed snapshot is 5 minutes
old, checking once a minute while someone is signed in and the counter is unlocked, so a healthy
counter's saved stock is under 6 minutes old against the 15-minute outage-entry limit. It also
renews whenever an outage is draining or the installed snapshot doesn't include the whole local
journal, but never while journal entries recorded here wait for the server: a pair issued then
could not include them. Each
renewal is a fresh signed command and attendance proof. A transient failure (network, 5xx,
`TEMPORARILY_UNAVAILABLE`) is retried after 1, 2, 4, then every 5 minutes; a refusal that needs a
person (`GRANT_INVALID`, `BRANCH_HOURS_NOT_CONFIGURED`, `RECONCILIATION_REQUIRED`, or a pair
that will not install) backs off from 1 to 30 minutes. A request ID is kept until its response
arrives, then discarded.

**Desktop install.** The verified pair replaces the installed one in a single SQLite
transaction, only if it is newer and its watermark is exactly this computer's journal head
(`journalCoverage` in `pos-desktop/src/main/terminal/offline-journal.ts`). A pair whose watermark
is behind the local head is refused `local_usage` (upload first). One whose watermark names
entries this computer doesn't have is refused `journal_mismatch` and never installed. Installing
resets the consumption counted against the replaced snapshot, which the new one already
includes. During a reconnect drain it is the drain's last step, as described below. A pair that
fails verification, is older than the installed one, or claims a newer version with older
evidence is never installed. Only the current pair is kept on the counter; the server keeps
every version.

## Held offline evidence verification (P3)

`HeldEvidenceVerifier` (`apps/api/src/terminals/held-evidence-verifier.service.ts`) verifies held
offline evidence against the grants this server issued. P5 sync calls it on its own transaction,
after verifying the device journal it takes the evidence from; there is no HTTP route. The caller
must be live at the branch. Verification takes the same record lock as intake, and the grant is
looked up only among `offline_authority_issuance` rows of the record's own tenant, branch and
enrollment, so another counter's grant is as unknown as a made-up one.

- `verifyHoursAcknowledgement(tx, user, branchId, { enrollmentId, recordId, managerSignIn, outage })`
  for a held D8 acknowledgement. `managerSignIn` is the `OfflineStaffSignIn` the acknowledgement
  cites; `outage` is `{ offlineSessionId, offlineStartedAt }` from the journal command that relies
  on it. Both are parsed with exact keys. The record moves to `accepted`, or to `rejected` with the
  reason in `heldReason`.
- `verifySupportRecord(tx, user, branchId, { enrollmentId, recordId, staffSignIn })` for a held sale
  incident or card-attempt event. It moves to `rejected` when the check below fails. When the check
  passes it stays `held` under its existing reason (`sale_unverified`, `payment_unverified`): the
  sale and the card-machine result are P5's to verify. Support records still post no stock, cash or
  refund effect.

The result is `{ recordId, status, reason, decided }`, where `decided` is true only on the call that
moved the record. A record that is already decided is returned as stored, and the P1 trigger lets
the outcome move only once. A record held as `enrollment_revoked` or `attempt_mismatch` is not P3's
to settle, so it is returned unchanged.

The first check that fails names the reason. The order is fixed, so the same evidence always gets
the same reason: grant, then the sign-in (identity, staff, credential, times), then capability,
outage, window and mandatory limit for an acknowledgement, or work session and named staff for a
support record.

| Reason | Acknowledgement | Support record |
| --- | --- | --- |
| `grant_not_issued` | No grant with `grantId` was issued to this enrollment | Same, for the sign-in's `grantId` |
| `grant_binding_mismatch` | Grant version, nomination version or device identity differ | Device identity differs |
| `sign_in_mismatch` | The sign-in is not `managerSignInId`, or is for another grant, device, register or till | Same, for `staffSignInId` |
| `staff_not_prepared` | The signed-in person is not in the grant's `authorizedStaff` | Same, and for the incident recorder or the card-decline verifier |
| `credential_version_mismatch` | Another `staffAuthorizationId`, `credentialVersion` or method than the grant authorized | Same |
| `outside_grant_window` | Sign-in or record outside `[notBefore, expiresAt)`, sign-in after the record, or the window ends after `expiresAt` | Sign-in or record outside the grant, or sign-in after the record |
| `manager_lacks_capability` | The grant did not give the manager `acknowledge_business_hours` | — |
| `work_session_mismatch` | — | The record's work session is not the sign-in's |
| `outage_mismatch` | Another `offlineSessionId`, or the outage began outside the grant or after the record | — |
| `mandatory_window_overridden` | The window is not wholly inside the grant's `mandatoryOperatingWindows` (when not `null`) | — |

The acknowledgement window may extend routine
`operatingWindows`, which is what it is for. It may never reach past a mandatory limit or the
grant's expiry.

## Offline journal sync (P5 #51)

`POST /api/v1/terminals/offline-journal/sync` (counter route, `terminal.execute`, `x-branch-id`)
takes the shared `SyncRequest` and returns a server-signed `Signed<SyncResponse>` (Ed25519,
purpose `sync_response`, the same `OFFLINE_AUTHORITY_KEY_ID` / `OFFLINE_AUTHORITY_PRIVATE_KEY`
as issuance; without them the route is 403 `TEMPORARILY_UNAVAILABLE`). This slice is the
server-side intake; the desktop producer is P4 #50.

**Authentication.** The uploader is a signed-in user live at the branch with `terminal.execute`;
a PIN-opened counter login must belong to this enrollment (else `IDENTITY_MISMATCH`). The
request's identity must be the caller's tenant and branch and every sign-in and command must
name the same identity. Every `staffSignIns` and `commands` envelope is checked against the
enrollment's pinned key, never a supplied one, before anything is stored: a bad signature refuses
the whole request (`INVALID_SIGNATURE`) and keeps nothing. Malformed or unknown fields anywhere
are 400 `INVALID_COMMAND` before any signature or policy check. At most 25 sign-ins, 25 commands
and 25 support records per request (and the API's 100 kB body limit): send more in pages, each
continuing from the previous response's watermark.

**Revoked or retired counters** may still upload, so old signed evidence is recoverable: exact
replays return their original receipts, and any new command is `held` with `TERMINAL_REVOKED`
and kept for review. Nothing new is written for them.

**Order.** Support records (through the existing `OfflineSupportRecords.record`), then sign-ins
(kept once per tenant + enrollment + `staffSignInId` in `offline_staff_sign_in`; other content
under a used ID is kept as a conflict), then commands **sorted by sequence**, each in its own
transaction under the enrollment's journal lock:

1. **Receipt first.** The tenant + enrollment + command ID, then + sequence, receipt
   (`terminal_command_receipt` with `offline_sequence`). Same identity, ID, digest and sequence
   (`classifyCommandReplay`) is `duplicate` with the original receipt — before any grant, expiry
   or revocation rule, so it works after the grant expired. Anything else under that ID or
   sequence is `rejected` `REPLAY_CONFLICT`. A receipt written by a manager's settlement of a
   rejected entry answers `reviewed` instead
   ([Refused offline journal entries](#refused-offline-journal-entries-p5-51-slice-4)).
2. **A rejection stands.** Content this server already rejected (the same digest, outcome
   `rejected` in `offline_journal_review`) is answered `rejected` with the stored code, never
   judged again (a clock that has caught up or a shift opened since cannot change the answer),
   until a manager settles it.
3. **Next in line.** The sequence must be the accepted head + 1 (else `held` `SEQUENCE_GAP`) and
   `previousCommandHash` must be the head's digest (`null` at sequence 1; else `rejected`
   `REPLAY_CONFLICT`). The digest is SHA-256 of the domain-separated `command` signing text.
4. **Historical validation**, never against today's catalog or clock: the grant this server
   issued to this enrollment (`offline_authority_issuance`; else `GRANT_INVALID`) and, for a sale,
   the signed snapshot it cites (`offline_stock_snapshot`; else `SNAPSHOT_INVALID`); the cited
   signed sign-in (missing: `held` `SESSION_INVALID`, so uploading it later repairs the entry);
   a cited D8 acknowledgement and its manager's sign-in (missing: `held`
   `BUSINESS_HOURS_ACK_REQUIRED`); the command's own `occurredAt` as the trusted time (no more
   than 5 minutes ahead of the server and not before the latest entry accepted on its own — a
   settled entry's time may be why it was refused, so it is not evidence of the clock — else
   `CLOCK_UNTRUSTED`); usage recomputed from the accepted sales on the same snapshot. Sales go
   through `offlineSalePolicyError`, shifts through `offlineShiftTransition`, with state
   `offline`; their codes are returned as `rejected`. Late arrival alone is never a refusal.
5. **Commit**, in that one transaction: the effect, its audit and the receipt.

Processing **stops at the first `held` or `rejected` command**; later commands get no
acknowledgement and stay queued on the counter. Every refused upload (held, rejected or conflict)
is retained, never deleted, in `offline_journal_review` (one row per distinct signed content,
`attempts` counts repeats). If the same content is refused again more severely (for example held
for its sign-in, then rejected once judged), the row's `outcome` escalates
(held < rejected < conflict) and keeps that refusal's code. It never softens. `committedThroughSequence` / `committedThroughHash` are the accepted
head; sequences are accepted only contiguously from 1, so it is always the highest contiguous
point and never jumps a gap or a refused entry.

**Sales (approved D1).** The sale is created at the snapshot's prices and tax (D6), sold at
`occurredAt` by the signed-in staff member, on the replayed shift (`shiftId` = the D7b work
session), with `offlineCommandId` set and `workSessionId` naming the offline sign-in. Cash is
stored as tendered with the change beside it (as online); an external card payment is `card`
with the provider reference. Under the batch locks, if every batch has the units available
(on hand − quarantined − reserved) and none is held by an open case, the whole stock effect is
posted through `StockService.issue` (no bypass), dated `occurredAt`. Otherwise **nothing** is
posted: the sale and payments stand with `stockPosting: pending_reconciliation`, and one
`offline_stock_discrepancy` case is opened with a line per batch (`soldQuantity`,
`availableQuantityAtSync`, `shortfallQuantity`, and why: `shortfall`, `batch_under_review` or
`sale_pending`) and a `batch_sale_block` on each of the sale's batches. The ack carries
`stockPosting` and `reconciliationCaseId`; a retry returns the same, case included. The shared
`OfflineStockDiscrepancy` is one line of a case (case ID + batch).

While a block is open: central checkout refuses that batch by name with 409
`BATCH_STOCK_REVIEW` and FEFO skips it (other batches, including the same product's, keep
selling); offline snapshots mark it `stockReviewRequired`; a later offline sale from it is
pending too (`batch_under_review`). A pending sale cannot be voided or refunded (409
`STOCK_POSTING_PENDING`): that would put back stock it never took. Cases are resolved, and their
blocks released, as in [Offline stock case resolution](#offline-stock-case-resolution-p5-51).

**Shifts (D7b).** `shift_open` creates the `till_shift` with the counter's work session ID, the
opening count (total only), the previous closed shift it names, `openCommandId` and the sign-in.
`shift_close` closes it with the counted cash, the server's expected cash from the replayed sales
(`expectedCashMinor`, so the variance is against the server's figure) and the counter's figure
beside it (`counterExpectedCashMinor`); an assisted close records the manager's sign-in, name and
reason. Each is replayed once: a resend is a `duplicate`, and a second close of a closed shift is
`rejected` `SESSION_INVALID`, never a reopen.

**Sync status for managers.** `GET /api/v1/terminals/offline-journal/sync-status`
(`tenant.management`, live at the branch; `x-branch-id`; not a counter route) returns
`CounterJournalSyncStatus`: the branch's `timezone` (times on the Counters page read in it) and
`enrollments`, read in one statement from the server's own tables and scoped by tenant and
branch: each counter's current enrollment, plus any earlier one (revoked key, retired computer)
whose journal stopped short or has stock cases open. Per enrollment: `head` (the highest accepted
`offline_sequence` and its receipt's `recordedAt`), `lastReceivedAt` (the latest accepted entry,
retained refusal or staff sign-in: the last upload that brought something new; an upload with
nothing new leaves no trace), `stoppedAt` (the lowest sequence past the head with a retained
refusal, most severe copy first: sequence, `held` / `rejected` / `conflict`, error code, first
received) and `openStockCases`. Intake stops at the first refusal, so there is at most one
stopping point and the server can't say how many entries follow it; a `rejected` or `conflict`
stop is the issuance's `RECONCILIATION_REQUIRED` rule. Refusals at or below the head are history.
The server sees only what a counter has sent; a counter offline now may hold more. Daily work
lists a current counter stopped on a `rejected` entry as `offline_journal.review` ("Review
refused offline entry", for `tenant.management`); conflicts and revoked or retired counters are
left to D11 journal recovery.

**Support acknowledgements.** `accepted` / `duplicate` for an accepted record; otherwise the
record is stored but still `held`, acknowledged `held` with `RECONCILIATION_REQUIRED` (its held
reason in the message), or `REPLAY_CONFLICT` for changed content under a used record ID. Gating
dependent commands on support-record verification is a later P5 slice.

**Desktop upload and reconnect drain (approved D12).** The nominated counter uploads its journal
(`pos-desktop/src/main/terminal/offline-journal-sync.ts`) every 15 seconds while someone is
signed in. It sends the entries the server hasn't accepted, in sequence order, 50 per request,
with every staff sign-in they cite. With nothing waiting, it sends an empty upload every
5 minutes, so the server confirms the whole journal.

- **Trust.** A reply is applied only if it verifies against the offline authority key (purpose
  `sync_response`) and names this identity. Its acknowledgements must match what was sent: one
  each, in order, with the exact hash, sequence and kind, nothing after a refusal and nothing
  committed past the watermark. Otherwise nothing in it is applied.
- **Outcomes.** `committed` / `duplicate` / `reviewed` entries are marked accepted, with the
  acknowledgement kept. `held` ones are resent after a minute. A `rejected` one is sent alone,
  at most once a minute, to learn whether a manager has settled it; nothing after it is sent
  until then. A lost reply is recovered by resending the same entries.
- **Watermark.** It is recorded only if it names this computer's own chain. One naming entries
  this computer doesn't have (`JOURNAL_MISMATCH`, e.g. a restored backup) is never adopted, and
  no new outage may start until it is recovered. Only a verified reply sets or clears it: a
  dropped connection or a reply that fails its checks leaves it in place.
- **Pause.** After an outage, new checkouts on that counter are refused `SYNC_PAUSED` until the
  drain finishes. Confirming an unconfirmed sale still works.
- **Finishing the drain.** The drain finishes, by `mayResumeOnlineCheckout`, when the journal is
  accepted through its last entry, nothing sent is `submitted` / `uncertain`, and a fresh pair
  rebased over the journal installs. That install ends the outage in the same transaction. If the
  server refuses the counter offline authority (no longer nominated, or `GRANT_INVALID`), the
  drain ends without a pair once the rest holds: online checkout checks stock centrally.

**Not yet (later P5 slices).**

- Support-record gating of dependent commands.
- Replacement / missing-journal review (D11 `journalRecoveryEvidence`).
- Backup and restore.
- The retention policy for journal evidence (nothing is deleted today).

## Refused offline journal entries (P5 #51 slice 4)

A command the server **rejected** stops its counter: entries are accepted only at head + 1, so
nothing after it can be accepted, and issuance refuses `RECONCILIATION_REQUIRED` while it stands.
A manager settles it here, remotely, so the counter can finish synchronising (approved D12).
Held entries are not settled here (the counter repairs them), and neither are conflicts with the
accepted chain or a revoked counter's journal (D11 journal recovery).

| Route | Permission | Notes |
| --- | --- | --- |
| `GET /offline-journal-reviews?status=open\|closed` | `sales.review_offline_entries` | The branch's rejected commands, newest first: `open` while one blocks its counter (unsettled, its sequence past the accepted head; never capped), `closed` once `settled` or `superseded` (overtaken; the newest 200). `occurredAt` is `null` where the counter's clock gave no date; `collectedNotSoldMinor` is the card money a not-honoured sale took |
| `GET /offline-journal-reviews/:id` | `sales.review_offline_entries` | The entry as signed, decoded (staff, shift, and for a sale its lines at the snapshot's prices with product and batch, and its payments); the refusal code with an explanation; attempts; the accepted head; `settleBlocker`; `recordable`; `notHonoured` (`{ ok, message }`: whether it may be not honoured, and what that leaves behind or why it must be recorded); every settlement with its approval evidence, `approvalReview` and `collectedPayments` |
| `POST /offline-journal-reviews/:id/settlements` | `sales.review_offline_entries` | Prepare `{ decision: "recorded" \| "not_honoured", reason }` (a reason is required, up to 500 characters); one waiting per entry. A preparer who may approve their own requests settles it at once. Optional `Idempotency-Key` (scope `offline_journal_settlement_prepare`): a retry replays the settlement, another decision or reason under the key is 400 |
| `POST /offline-journal-reviews/settlements/:id/approve` | `sales.review_offline_entries` | `{ approvalId, expectedVersion, expectedDigest }` from `approvalReview`. Approving settles; a retry with the same `approvalId` returns the settlement |
| `POST /offline-journal-reviews/settlements/:id/cancel` | `sales.review_offline_entries` | A decision still waiting for approval |

**Decisions.**

- `recorded` — the entry's effect is written as the counter recorded it, under the enrollment's
  journal lock, every condition checked again at approval:
  - **A sale** needs the grant and snapshot this server issued to the counter, the uploaded
    sign-in (this counter's, for the entry's own person and shift), the grant's register and
    till, figures that are exactly the snapshot's (lines in it, none repeated, its price, no
    discount, half-up tax per line, the total, cash tendered less change equal to the amount, a
    card's provider reference, payments equal to the total), its batches still at the branch,
    and its shift open on the server and the seller's own, opened on this counter. It is created
    as at intake (snapshot prices, seller, shift, payments, `offlineCommandId`), dated at `occurredAt` but
    never after the server first received the entry, and **always** `pending_reconciliation`: an
    offline stock case opens with every batch blocked (line reason `entry_reviewed`, or
    `shortfall` / `batch_under_review` where those apply). No stock moves on a remote approval;
    the case is resolved at the counter as in
    [Offline stock case resolution](#offline-stock-case-resolution-p5-51).
  - **A `shift_open`** needs no shift open on the till and its work session ID unused; it is
    replayed as at intake.
  - **A `shift_close`** needs the same shift still open (same till, register and cashier); it is
    replayed as at intake, its variance against the server's expected cash. An assisted close is
    signed in by the manager who closed it, on the same register and till.
  - Shift entries also need the uploaded sign-in, matched as for a sale.
  - Shift times are dated like a sale's, and a close never before its open. A counter time that
    is no date at all is dated when the server first received the entry.
  - The till is judged under intake's own locks, taken after the journal lock in intake's order
    (the counter row, and the shift for a close, `FOR UPDATE`; a sale's shift `FOR SHARE`), so
    a shift opened or closed by intake meanwhile is seen, not raced; a till whose shifts changed
    under a write anyway is 409.
  - Otherwise 409 with the reason; `recordable.blocker` is one of `grant_unknown`,
    `snapshot_unknown`, `sign_in_missing`, `lines_unknown`, `prices_differ`, `totals_differ`,
    `payments_differ`, `batch_missing`, `shift_not_open`, `shift_not_theirs`,
    `sign_in_mismatch`, `till_mismatch`, `till_has_open_shift` or `shift_id_used`.
- `not_honoured` — no sale, stock or shift change is written. Cash the counter took for a
  refused sale shows in that shift's variance when it closes. A card payment it took is kept as
  an `offline_collected_payment` (collected, not sold: method, amount, provider reference,
  approval code, the shift if the server has it, the seller), retained, for a refund or a
  re-sale at the counter; the settlement lists it as `collectedPayments`. **A shift record the
  till can take is recorded**: not honouring it is 409 (`notHonoured.ok: false`), because every
  later record in that shift would then be unrecordable.

**What every settlement writes**, in one transaction: the `terminal_command_receipt` at the
entry's own sequence with its own digest (operation `offline_journal:<kind>`, actor the
approver), whose result carries `review: { settlementId, refusalCode, settledAt }` and the
decision's outcome; the `offline_journal_settlement` (immutable apart from its progress; one
settled per entry and per sequence); and audit `offline_journal_settlement.settled` (with
`.prepared` and `.cancelled`; the sale's and shift's own audits carry `journalSettlementId`).
Later entries chain on that receipt like any other. Usage for later sales on the same snapshot
still counts a recorded sale.

**Nothing to settle** (`settleBlocker`, 409 on prepare or approve): `not_rejected`, `settled`,
`not_next` (the entry no longer follows the accepted head, or its command ID was accepted with
other content), `forked` (the counter also sent a different entry refused at the same sequence,
as after a restored backup: D11) and `counter_revoked` (a revoked or retired counter: D11).

**Approval** uses exact approval (`management_approval`, document type
`offline_journal_settlement`, action `offline_journal_settlement.execute`). The material is the
entry (review, identity, command ID, sequence, digest, outcome), the decision and reason, and the
accepted head it follows, so a different entry taking its place makes the approval
`APPROVAL_STALE`. `sales.review_offline_entries` (owner and manager by default) prepares and
approves, under the tenant's self-approval policy. It is management work: no counter, and no
stock moves.

**The counter learns it by resending.** Resending the refused content returns the stored refusal
until it is settled (a revoked or retired counter is answered `held` `TERMINAL_REVOKED` instead,
and the stored refusal stands). Then step 1 finds the settlement's receipt and acknowledges it
`status: "reviewed"` with `committedAt`, `review`, `commandKind` and `decision`; a recorded
sale adds `saleId`, `stockPosting: "pending_reconciliation"` and `reconciliationCaseId`, a
recorded shift entry `workSessionId`. The desktop accepts `reviewed` only from a verified reply
(a recorded sale must be pending on a case), marks the entry accepted and carries on with the rest
in the same cycle. Once the journal is accepted, issuance no longer refuses and the drain
finishes.

## Offline stock case resolution (P5 #51)

Approved D1 and revised D10: an offline sale whose stock could not post at sync waits on an
`offline_stock_discrepancy` case. A manager reviews the case and approves exactly how it is
resolved, remotely; the counter executes it. Review, plans and approval move nothing.

| Route | Permission | Notes |
| --- | --- | --- |
| `GET /offline-stock-cases?status=open\|resolved` | `inventory.resolve_stock_cases` | The branch's cases, newest first, with the sale, counter, pending and short units and the current plan |
| `GET /offline-stock-cases/:id` | `inventory.resolve_stock_cases` | The evidence (below) and every plan |
| `POST /offline-stock-cases/:id/resolutions` | `inventory.resolve_stock_cases` | Prepare a plan `{ kind, links?, note? }` (one open plan per case) |
| `POST /offline-stock-cases/resolutions/:id/approve` | `inventory.resolve_stock_cases` | `{ approvalId, expectedVersion, expectedDigest }` from the plan's `approvalReview` |
| `POST /offline-stock-cases/resolutions/:id/cancel` | `inventory.resolve_stock_cases` | A plan not yet executed |
| `GET /offline-stock-cases/resolutions/ready` | `inventory.manage` (counter route) | Approved plans here: batches to count (product, batch, expiry, sold quantity — never the system quantity), requester, approver, `approvalEvidenceId`, `approvalState` |
| `POST /offline-stock-cases/resolutions/:id/execute` | `inventory.manage` | Always 403 `TERMINAL_REQUIRED`: the route the signed operation names, never a browser execution |

**Evidence** (`GET /offline-stock-cases/:id`): the sale with its receipt lines, payments and
`stockPosting`; the offline evidence (counter, journal sequence and digest, `occurredAt`, the
signed sign-in and its staff member, when it synced and who uploaded it); the snapshot it was
sold from; and per batch: sold, available at sync, shortfall and why it waits, **pending units**
(this case's and every other open case's on the batch), on hand / quarantined / reserved /
available now, whether it is blocked, the **timeline since the snapshot** (every ledger movement:
online sales with their invoice numbers, receipts, transfers, stocktakes, quarantine, adjustments,
with actor and time; the latest 300 per batch, `timelineTruncated` when there are more, and then
no `timelineDigest`; execution digests the whole timeline), stocktake counts of the batch since
the snapshot (`settlesThisSale` when posted and counted after the sale), active reservations, and
write-off/correction movements after the sale with unlinked units (never a stock case's own count
correction). Plans carry requester,
approver and executor separately, `approvalState` (`none`, `matches`, `changed`, `revoked`) and
the `approvalReview` to approve; a resolved case lists one settlement per batch.

**Plans.** `kind` is one of:

- `post_now` — stock now covers every batch of the sale (for example after a receipt). The sale's
  full stock effect is posted through `StockService.issue`, dated at the sale, with the usual
  availability check; if it no longer covers, 409 `STOCK_NOT_COVERED` and nothing moves. If a
  posted stocktake counted one of the batches after the sale, the count already took the units
  off, so posting them again is refused 409 `SETTLEMENT_ALREADY_COUNTED` (at preparation and at
  execution): link that stocktake or count instead.
- `count_and_correct` — the counter counts every batch of the case (all units of the batch at the
  branch, sellable or held, after the sale left the shelf). Each batch is corrected once
  (`adjustment_in` / `adjustment_out`, reference `offline_stock_resolution`) to
  **count + every open case's pending units on that batch**, then the sale posts. Central stock
  then equals the count plus what other open cases still owe, so nothing the count already
  reflects is deducted twice and no balancing stock is invented. The count covers held units
  too: they stay held as far as the count leaves room beside the sale's units, and any beyond
  that come off the quarantine bucket, so the sale always posts from sellable stock. If reserved
  units leave too little to post the sale, 409 `STOCK_NOT_COVERED`.
- `link_existing_settlement` — every batch names what already took the sold units off:
  `{ batchId, source: "stocktake", stocktakeId }` (a posted stocktake whose count of the batch was
  taken after the sale) or `{ batchId, source: "movements", ledgerEntryIds: [...] }` (write-offs or
  corrections on the batch after the sale; each movement's units are linked at most once across
  all cases, and they must cover every sold unit). Nothing is posted; the link is recorded.
  Otherwise 409 `SETTLEMENT_NOT_LINKABLE` (at preparation and again at execution).

A plan's content is immutable (database trigger); to change it, cancel it and prepare another.

**Approval** uses the exact-approval machinery (`management_approval`, document type
`offline_stock_resolution`, action `offline_stock_resolution.execute`): the material is the case
(sale, command, each line), the plan, and **the other cases holding each batch** — those still
open, and those resolved after the plan was prepared, so another case settling never changes what
was approved. Approval needs `inventory.resolve_stock_cases` (owner and manager by default) under
the tenant's self-approval policy; a preparer who may approve their own requests approves as they
prepare. Any material change — notably another offline sale on one of the batches opening a case
— makes the approval `APPROVAL_STALE` at execution and the plan `changed` in both lists and in
daily work ("Approve stock case plan again"); approve again.

**Execution** is a signed counter command only (`POST /terminal-commands/execute`, operation
above), local physical execution under revised D10: the browser route refuses, an unsigned
request is `TERMINAL_REQUIRED`, and it is never an offline journal command (a journal entry of any
other kind refuses the upload, 400). Executing needs `inventory.manage` live and the plan's
current approval. One READ COMMITTED transaction locks the case, the plan, then the case's batches
(id order), re-checks the exact approval under those locks, and then: posts, corrects or links;
writes one `offline_stock_settlement` per batch (method, sold, on hand before, pending on the
batch, count with time and counter, correction, posted, links, timeline digest, approval and
command IDs); sets the sale's `stockPosting` to `posted`; resolves the case; releases **this
case's** batch blocks; and audits `offline_stock_discrepancy.resolved` with requester, approver
and executor. A batch another open case holds stays blocked (`stillBlocked` in the result); other
batches and counters are never paused. A retry of the same signed command returns its original
receipt; a distinct later command for an executed plan is refused (`APPROVAL_INVALID`) and
changes nothing.

Result: `{ type: "offline_stock_case.resolved", resolutionId, caseId, saleId, approvalId, kind,
effect, batches: [{ batchId, method: posted|counted|linked, soldQty, countedQty, correctionQty,
postedQty, stillBlocked }] }`.

After resolution the sale voids and refunds normally, and new snapshots no longer mark its batches
`stockReviewRequired` unless another open case still holds them.

