# P1 acceptance-test audit (Epic #47)

Audited against `develop` at `e1f0de1` (2026-11-02), and re-checked at `e82aa7a` (2026-11-04),
after P2 [#93](https://github.com/ShafeekSaleem/PharmaCeylon/pull/93), MR 10a
[#100](https://github.com/ShafeekSaleem/PharmaCeylon/pull/100) and MR 10b
[#102](https://github.com/ShafeekSaleem/PharmaCeylon/pull/102) merged. Each acceptance criterion in
[#47](https://github.com/ShafeekSaleem/PharmaCeylon/issues/47) is split into the claims it
makes. Each claim is mapped to the tests that prove it.

This document ticks nothing. The checkboxes on #47 stay with the issue owner.

**Status legend**

- **PROVEN**: unit and/or PostgreSQL tests exercise the claim through the real code path.
- **PARTIAL**: the delivered part is proven; the rest is named in the row.
- **WAITS ON …**: the behaviour does not exist on `develop` yet, so nothing can test it. The
  status names the work it waits on. The first audit marked these rows BLOCKED-ON-P2. P2 (#93)
  has since merged. The rows that were waiting on it are now PROVEN or PARTIAL. The rest were
  waiting on other work, and now say which.
- **MISSING**: delivered on `develop` but not tested. This audit leaves no row MISSING.

**Where tests live.** Paths are relative to `apps/api`. `int:` means `test/integration/*.int-spec.ts`,
run with `npm run test:integration -w api`. `unit:` means a colocated `src/**/*.spec.ts`.
Tests marked **(new)** were added by the first audit. Tests marked **(new, re-check)** were added
by the 2026-11-04 re-check. `desktop:` means `apps/pos-desktop/src/main/**/*.spec.ts`, run with
`npm run test -w pos-desktop`.

## AC1: negative boundary tests, and remote management positives

> Negative tests reject remote physical execution, wrong-tenant/branch/enrollment, revoked devices, altered signatures/digests and unverifiable attendance, including owner calls. Positive tests allow branch-authorized remote management and normal business reservation effects without terminal proofs.

| Claim | Status | Tests |
|---|---|---|
| Remote (browser/owner) caller cannot run a **signed** physical operation | PROVEN | unit `security/operation-authorization.service.spec.ts`: "owner cannot execute %s without terminal evidence"; int `terminal-execution`: "an owner's browser session cannot post stock: no terminal proof, no borrowed session, no unenrolled key" **(new)** |
| Legacy **browser** physical routes (`POST /stocktakes/:id/post`, `/transfers/:id/ship`, checkout, …) refuse non-terminal callers | WAITS ON W1 rollout + P6 | Not enforced on `develop`: browser routes still post by design. Coordinated production enforcement is still an open #47 item. It no longer waits on #93. It waits on two things: W1 rollout, meaning branches actually going live (the W1 #63 web foundation is done), and the P6 [#52](https://github.com/ShafeekSaleem/PharmaCeylon/issues/52) counter screens that replace each browser physical route. The branch state enforcement will key on is built: int `pos-rollout`: "starts every branch not live", "refuses a fallback on a branch that isn't live, at the database too", "runs a fallback on a live branch and audits each change with the branch". Import undo is the exception: it is already limited to non-live branches (int `import-stock`: "only offers legacy physical undo at its selected non-live branch"). |
| Wrong tenant / wrong branch | PROVEN | int `terminal-execution`: "rejects another tenant's owner and a different branch header"; unit `terminal-commands/terminal-command.executor.spec.ts`: "rejects a branch header or tenant that differs from the signed identity before any transaction"; int `terminal-foundation`: "rejects a terminal at another tenant's branch"; int `terminal-verification`: "rejects another key, another branch, another authenticated staff member and another operation" |
| Wrong enrollment / another device's key | PROVEN | int `terminal-execution`: "rejects another enrollment's identity and another device's signature"; int `terminal-foundation`: "binds enrollments to the exact tenant, branch and terminal", "rejects mismatched receipt identity including the signing key"; int `terminal-verification`: "requires possession of the challenge's candidate enrollment key" |
| Revoked device (execution and replay) | PROVEN | int `terminal-execution`: "rejects execution and replay from a revoked device"; int `terminal-verification`: "revocation closes staff bindings and blocks previously prepared commands without deleting history", "enrollment lock makes a revocation that wins the race block verification"; unit executor: "refuses replay to another staff user and to a revoked enrollment" |
| Altered signature | PROVEN | unit `terminals/terminal-wire.spec.ts`: "accepts a strictly parsed real Ed25519 signature and rejects a different key", "rejects envelope key injection, padded/noncanonical signatures and unknown algorithms", "rejects a signature from another protocol purpose"; int `terminal-execution`: "rejects another enrollment's identity and another device's signature" |
| Altered payload / digest | PROVEN | int `terminal-verification`: "rejects identity, drawer, staff, nonce, evidence and payload substitutions even when re-signed"; int `terminal-execution`: "rejects an altered replay of a committed command and an altered unexecuted command"; unit executor: "rejects altered content for a committed command identity as REPLAY_CONFLICT" |
| Replayed nonce | PROVEN | int `terminal-verification`: "consumes a challenge only once under concurrent verification"; int `terminal-execution`: "a spent nonce cannot carry a new command ID" **(new)** |
| Expired command | PROVEN | unit `terminal-wire.spec`: "enforces trusted time and bounded challenge lifetime"; int `terminal-verification`: "rejects expiry and a caller-selected time window"; int `terminal-execution`: "refuses an expired command without spending its nonce; the same command still runs once in time" **(new)** |
| Stale sign-in (token version bumped after signing) | PROVEN | int `terminal-verification`: "rechecks membership, token version and branch roles rather than cached owner claims"; int `terminal-execution`: "refuses a command signed before the executor's sign-in changed, and its replay" **(new)** |
| Live permission removed (execution and replay) | PROVEN | int `terminal-execution`: "refuses execution and replay after the operation permission is removed", "refuses execution and replay to a custom role without terminal.execute"; int `terminal-verification`: "rejects a custom permission removed during verification's enrollment lock wait"; unit executor: "refuses replay when live branch authority is gone" |
| Unverifiable attendance, owner included (fails closed) | PROVEN | int `terminal-execution`: "rejects unverified attendance for the owner", "denies execution without a test attendance or hours provider"; int `terminal-verification`: "rejects unknown/remote attendance evidence including for an owner", "default production attendance denies owner enrollment and preserves the unconsumed challenge"; unit `terminal-wire.spec`: "production attendance verification denies a claim that was never recorded as a proof" (renamed by #93) |
| Real independent attendance accepted | PROVEN | The production `LocalAttendanceVerifier` now accepts a console proof that desktop main signed and `AttendanceProofsService` recorded (D-P2a). int `terminal-enrollment`, run with the production verifier and recorder ("nothing is stubbed"): "enrolls a console-attended device and opens a staff session on it", "refuses %s" (a Remote Desktop session, the remote flag on a console session, an unidentified session), "refuses an attestation signed by a key other than the one being enrolled", "refuses an attestation for a different challenge, counter, actor or branch", "consumes a proof once and leaves it usable when the operation rolls back", "does not accept an enrollment proof for a session, or a used proof twice", "refuses session attestations from a revoked device", "keeps proof content immutable and never deletes it", and for PIN sign-in "needs this counter's key and a console proof, and counts no guess without them". int `offline-activation`: "activates the authorized counter once, recording authorizer and activator separately", "refuses activation from a counter other than the authorized target". int `terminal-execution`: "posts once on a console proof recorded for the command, through the production verifier" **(new, re-check)**, for a signed physical command (refuses an RDP attestation, replays a lost response without the spent proof, and refuses the spent proof for another command). The other signed-domain tests keep the fixture verifier, which is bound to the same exact expectation. The accepted v1 limit is decided, not tested: remote-control tools that drive the console session look local to Windows (D-P2a). |
| Positive: remote management without terminal proof | PROVEN | unit `operation-authorization.service.spec`: "permits remote management/reservations at %s without a terminal"; unit `security/operation-classification.spec.ts`: "permits remote management classification for %s"; int `management-approvals`: "permits remote approval and exact scoped use for %s without posting effects"; int `offline-assignment`: "lets an owner authorize one exact enrolled target, remotely and idempotently" |
| Positive: normal business reservations without terminal proof | PROVEN | int `transfers`: "approves the exact displayed content: reservation only, no ledger movement"; unit `operation-classification.spec`: "keeps normal reservations remote but both transfer execution ends local"; int `workflows`: "counts reserved units as on the shelf, so a pending transfer creates no false surplus" |

## AC2: mixed handlers, imports, jobs, payments, approvals and audit

> Tests cover mixed-handler splitting, stock-bearing import/undo, catalog-only remote jobs, evidence-backed bank-payment records versus local cash, stale or cross-action/document approvals, live approver authority, existing self-approval settings and separate approval/execution audit. No indirect physical posting through approval, legacy routes or workers.

| Claim | Status | Tests |
|---|---|---|
| Mixed-handler splitting (no route is mixed) | PROVEN | unit `operation-classification.spec`: "explicitly covers every inventoried route with no extra or duplicate declaration", "separates remote write-off requests from direct counter adjustments", "resolves import confirm from where the stock goes, never defaulting to remote", "keeps stocktake posting physical after approval is separated"; int `workflows`: "authorizes without stock effects, then posts exactly once under concurrent retries", "requests write-offs only, and never moves stock even for someone who could post it"; int `held-approvals`: "approves without physical effects, then posts exactly once with separate attribution"; int `terminal-execution`: "refuses a write-off that needs approval with no effect, receipt, held request or spent nonce" |
| Stock-bearing import and undo | PROVEN | int `import-stock`: "replaces drafts without creating batches, stock, totals or reservations; stale posting fails", "posts one category per atomic chunk, replays saved IDs and rejects replacement after any posting", "serializes concurrent retries into one stock effect", "retains legacy non-live import and physical undo while remote undo cannot delete stock", "retains posted draft history and refuses undo after stock moves"; int `terminal-execution`: "posts staged import stock once and reports a later distinct command as already applied", "undoes untouched legacy import stock once through a signed command" |
| Catalog-only remote jobs (import/NMRA workers) | PROVEN | int `worker-provenance`: "persists the starting request's authority and writes with it", "writes nothing when the starter's permission is removed before the worker runs", "stops mid-job when the starter's sign-in changes between write chunks", "never writes for a legacy row that has no recorded authority", NMRA "stops a relation phase at its next write batch when the permission is removed mid-phase"; unit `security/worker-authority.spec.ts` |
| Evidence-backed bank payment vs local cash | PROVEN | int `payment-evidence`: "records evidenced %s remotely with one atomic ledger/audit/evidence link", "fails closed without a real provider and never maps cash/other or legacy paths to bank authority", "rechecks current pay permission after the original invoice lock wait"; unit `operation-authorization.service.spec`: "bank records require independent evidence; cash cannot use the remote bank path", "rejects bank-to-cash fact changes during evidence verification" |
| Stale / cross-action / cross-document approvals | PROVEN | int `management-approvals`: "cannot cross branch, tenant, action or document identities", "rejects a preview made stale before the manager approves", "revocation and expiry deny new use while retaining immutable original evidence"; int `held-approvals`: "rejects a stale posting confirmation after approval is replaced"; int `terminal-execution`: "refuses a held write-off command pinned to a replaced approval"; int `transfers`/`receiving-returns`: "refuses a dispatch command pinned to a replaced approval", "refuses a command whose approval is not the document's current one" |
| Live approver authority at execution | PROVEN | int `management-approvals`: "rechecks the exact approval after a mandatory evidence wait: %s", "rechecks the approver after a real approval-row lock wait", "rechecks approver rights, membership and current self-approval rules"; int `workflows`: "rechecks the approver's current authority separately from the executor"; int `terminal-execution`: "refuses an approval whose approver has since lost the right to approve; a sign-in change alone does not void it" **(new)** |
| Existing self-approval settings preserved | PROVEN | int `management-approvals`: "preserves configurable self-approval without imposing two different approver/executor people"; int `held-approvals`: "enforces existing self-approval policy and rejects wrong-branch execution"; int `workflows`: "enforces self-approval for every counter, not only the stocktake creator"; unit `security/access.service.spec.ts` |
| Separate approval and execution audit | PROVEN | int `terminal-execution`: "lost response: retry returns the identical original result with one effect and one audit chain" (approvedBy/executedBy + command provenance); int `receiving-returns`: "approves without stock, receipt or invoice, then posts exactly once with three actors recorded"; int `transfers`: "dispatches once: stock leaves the source, is in transit, and the audit names every actor" |
| No indirect physical posting via approval or workers | PROVEN | int `management-approvals`: "permits remote approval and exact scoped use for %s without posting effects"; int `refund-requests`: "prepares within the original-sale limit and refuses beyond it"; lint scanners `scripts/check-stock-writes.mjs` and `../../scripts/pos/check-mutation-inventory.mjs` (route inventory) |
| No indirect physical posting via **legacy browser routes** | WAITS ON W1 rollout + P6 | Same as AC1: browser physical routes still post until coordinated enforcement, which waits on branches going live (W1 rollout) and the P6 #52 counter screens. #93 is merged and no longer what it waits on. |

## AC3: clinical evidence

> Clinical checks require applicable evidence independently of ownership; ordinary permission administration remains available without granting a device or pharmacist bypass.

| Claim | Status | Tests |
|---|---|---|
| Clinical qualification independent of ownership or role | PROVEN | int `pharmacist-registration`: "is not satisfied by any role, an owner's included", "refuses expired and revoked registrations", "needs an active account assigned to the branch", MandatoryOperationEvidence.clinical "checks the signed session's staff member"; int `pharmacist-registration`: "the operation boundary demands a registration for clinical work even from an owner on a verified counter" **(new)**; unit `operation-authorization.service.spec`: "clinical qualification is mandatory even with a terminal and every permission", "re-resolves clinical facts after terminal lock waits" |
| Fails closed without a provider | PROVEN | int `pharmacist-registration`: "does not accept co-sign evidence online yet, and fails closed without a provider" |
| Permission administration grants no pharmacist bypass | PROVEN | int `pharmacist-registration`: "a custom role holding every permission key is still not qualified, and cannot record its own registration" **(new)**, "refuses managers, whatever their permissions" |
| Permission administration grants no device bypass | PROVEN | int `terminal-execution`: "refuses execution and replay to a custom role without terminal.execute"; the owner case in AC1 |
| Ordinary role administration still works | PROVEN | int `back-office-access`: "edits a custom role's web scope independently, keeps tenant boundaries and refuses owner lockout" |
| Pharmacist PIN co-sign checks the SLMC registration | PROVEN | MR 10b (#102) checks the co-signer on the checkout's own transaction, after their PIN, through `clinical/pharmacist-registration.service.ts`. int `pharmacist-registration` "controlled checkout co-sign (P1 #47 with P2 #93)": "refuses a co-signer with no registration, an expired one or a revoked one, and sells nothing", "accepts a registered co-signer and keeps the registration it relied on with the sale", "waits for a revocation in progress and is refused once it commits", "pins a sale's registration to its dispenser in the database"; unit `sales/sales.checkout-controlled.spec.ts`: "checks the co-signer's registration on the checkout's own transaction, after their PIN", "refuses an unregistered, expired or revoked co-signer with a coded 403 that names them", "lets other failures through unchanged", "makes a named co-signer the dispenser even when the seller could dispense alone". Not this row: a seller who dispenses alone with no co-sign. On the web POS before go-live and during a fallback, that seller is still trusted by role. Open PR [#109](https://github.com/ShafeekSaleem/PharmaCeylon/pull/109) checks their registration at every branch, and replaces the "trusted by role … (still open, MR 10)" tests in both files. |
| Clinical work through the signed executor | PARTIAL | Prescriptions are a signed clinical operation (MR 10a, #100). int `terminal-execution` "prescriptions through signed commands (clinical)": "records once for a registered pharmacist, replays the original result and audits the registration", "refuses an owner or manager with no registration: no prescription, receipt or spent nonce", "refuses a command prepared before the registration was revoked"; int `pharmacist-registration` "the unsigned prescription route at a branch live on PharmaCeylon POS": "refuses outside a fallback, whoever calls it, and records nothing"; desktop `terminal/signed-commands.spec.ts`: "sends a signed clinical command, with no approval or co-sign evidence, and keeps its receipt", "treats a missing SLMC registration as a final refusal the counter can explain". Open: co-sign evidence on a signed prescription command waits on the desktop Sell work. Checkout is not a signed operation; its clinical check is the co-sign row above. |

## AC4: concurrent retry and lost response

> Concurrent retry and lost-response tests produce one business effect, one accountable transactional success audit chain and the original replay result; altered command replays fail.

| Claim | Status | Tests |
|---|---|---|
| Lost response replays the original result | PROVEN | int `terminal-execution`: "lost response: retry returns the identical original result with one effect and one audit chain", "posts a held delivery once and replays the goods receipt"; int `receiving-returns`: "posts a prepared delivery once; a lost response replays the original receipt" |
| Concurrent retries give one effect, one audit chain | PROVEN | int `terminal-execution`: "concurrent identical retries produce one effect and the same receipt", "posts a held write-off once, notifies after commit and replays the original result"; int `transfers`: "concurrent identical dispatch retries produce one effect and one receipt"; int `refund-requests`: "concurrent retries and browser executions refund once"; int `payment-evidence`: "replays concurrent/lost responses and a later different key without another financial effect"; int `terminal-foundation`: "permits only one concurrent insert for a command, regardless of actor or content"; unit executor: "replays the committed original after a receipt unique violation instead of executing again" |
| Altered command replays fail | PROVEN | int `terminal-execution`: "rejects an altered replay of a committed command and an altered unexecuted command"; unit executor: "rejects altered content for a committed command identity as REPLAY_CONFLICT" |
| Replay keeps live authority | PROVEN | int `terminal-execution`: "refuses execution and replay after the operation permission is removed", "refuses to replay another staff member's receipt", "replays a committed command while unrelated work holds the enrollment lock" |
| Offline sequence receipts | WAITS ON P5 | Nothing produces offline receipts yet. They come with P5 [#51](https://github.com/ShafeekSaleem/PharmaCeylon/issues/51) offline sync and reconciliation, not P2. int `terminal-foundation`: "rejects reused offline sequence but allows multiple online receipts" covers only the schema. |

## AC5: injected failures and existing invariants

> Injected business/audit/receipt failures roll back the whole operation; existing central last-unit concurrency and tenant/stock-write checks still pass.

| Claim | Status | Tests |
|---|---|---|
| Business, domain-audit, execution-audit and receipt failures roll back everything (nonce included) | PROVEN | int `terminal-execution`: "%s failure leaves no trace and the same signed command then succeeds once" (business / domain audit / execution audit / receipt), "takes no approval evidence and rolls everything back when the adjustment audit fails"; int `terminal-verification`: "rolls back consumed nonce and success audit with a downstream failure"; int `terminal-foundation`: "rolls back receipt and audit together when their transaction fails" |
| Same, for the other signed domains | PROVEN | int `transfers`: "an injected audit failure rolls back the dispatch, its receipt and nonce; the retry succeeds once"; int `refund-requests`: "an injected audit failure rolls back stock, money, request and receipt; the retry refunds once"; int `receiving-returns`: "dispatches a supplier return once and rolls everything back on an injected failure"; int `payment-evidence`: "rolls back payment, allocations, settlement, evidence consumption and idempotency on audit failure"; int `support-records`: "rolls back the record when its success audit fails" |
| Last-unit concurrency still holds | PROVEN | int `stock`: "never sells more than is on the shelf when tills race for the last units"; int `workflows`: "leaves every batch's running totals equal to the ledger" |
| Tenant / stock-write checks still pass | PROVEN | `npm run lint -w api` (`check-tenant-scoped-mutations`, `check-tenant-data-entrypoints`, `check-stock-writes`) |

## AC6: device fixtures and integrated attendance

> API device fixtures can exercise P1 before desktop UI completion; integrated local-attendance enforcement is demonstrated with P2 before operational rollout.

| Claim | Status | Tests |
|---|---|---|
| API device fixtures exercise P1 | PROVEN | `test/fixtures/terminal-device.ts` (real Ed25519), used by int `terminal-execution`, `terminal-verification`, `transfers`, `receiving-returns`, `refund-requests`, `support-records`, `hours-evidence`, `offline-assignment` |
| Integrated local-attendance enforcement with P2 | PARTIAL | Both halves of #93 are proven against the shared `LocalAttendanceAttestation` contract. API: the production-verifier tests in AC1 "Real independent attendance accepted". Desktop main: desktop `terminal/terminal-service.spec.ts`: "enrolls with a fresh key, proves attendance and signs the manager out", "binds the attestation to the challenge digest the server computes", "refuses to enroll from a remote session before contacting the server for a proof", "refuses an attended action while a remote-control tool is running, before any proof", "shows a waiting authorization and activates it with a signed, attended command", "refuses to activate from a remote session"; desktop `attendance/remote-tools.spec.ts`. Open: no automated test drives the desktop client against a running API. The criterion's "demonstrated … before operational rollout" is a go-live step on a real counter, not a test. |

## Operational-readiness acceptance additions (unchecked items)

| Claim | Status | Tests |
|---|---|---|
| Incident and external-card-attempt records: held, immutable, no stock/cash/refund effects | PROVEN | int `support-records`: "persists the signed note as held evidence, replays identical uploads and moves nothing", "refuses a card number in the note before anything is stored", "holds an event that disagrees with its attempt's draft, amount, reference or linked sale", "rejects another device's signature, a wrong branch, an untrusted clock and a stale uploader", "keeps signed content immutable, the outcome final and conflicts permanent"; unit `terminals/offline-support-records.spec.ts` |
| P3/P5 acknowledgement / grant / manager verification before dependent sale/shift commands | WAITS ON P3/P5 | Offline grants are P3 [#49](https://github.com/ShafeekSaleem/PharmaCeylon/issues/49); acknowledgement and manager verification come with P5 #51 sync. Until then, records stay held. No HTTP intake route exists yet; P5 sync will call the intake. |
| Material revisions vs notes vs partial counters | PROVEN | int `management-approvals`: "notes retain approval and advance only metadata for %s", "material line changes invalidate %s, even when restored to the old value", "partial receipt counters do not rewrite approved material or revision", "header prices/destination and line insert/delete are material; version rollback is denied"; int `workflows`: "preserves approval on note edits and invalidates material edits even when restored"; int `held-approvals`: "preserves notes but invalidates a changed-and-restored payload"; int `import-stock`: "invalidates internal material edits and change-then-revert; freezes posted material" |
| Remaining quantities and current authority enforced transactionally | PROVEN | int `transfers`: "two partial receives of the same count post once; the stale one is refused"; int `refund-requests`: "refuses a revoked approval and a refund that exceeds what is now returnable"; int `held-approvals`: "keeps an approved write-off intact when later sales leave insufficient stock" |

## Mandatory evidence ports fail closed

| Port | Tests |
|---|---|
| Hours | int `hours-evidence`: "fails closed while the branch has no structured hours", "refuses another tenant's branch identity as unknown hours"; int `terminal-execution`: "denies execution without a test attendance or hours provider" |
| Bank payment | int `payment-evidence`: "fails closed without a real provider and never maps cash/other or legacy paths to bank authority" |
| Clinical | int `pharmacist-registration`: "does not accept co-sign evidence online yet, and fails closed without a provider" |

## Still unproven, and why

Re-checked 2026-11-04. Real local attendance (AC1), the PIN co-sign SLMC check (AC3) and clinical
work through a signed operation (AC3) were open in the first audit. They are now proven by the
tests above.

1. **Browser physical routes are not refused yet.** Coordinated enforcement waits on W1 rollout
   (branches going live) and the P6 #52 counter screens (AC1, AC2).
2. **Desktop and API attendance are each proven, but not run together.** Each side is tested
   against the shared contract. The demonstration on a real counter is a go-live step (AC6).
3. **Co-sign evidence on signed prescription commands.** Waits on the desktop Sell work (AC3).
4. **Offline sequence receipts.** P5 #51 (AC4).
5. **Acknowledgement, grant and manager verification of held records.** P3 #49 / P5 #51 (readiness).

Out of scope here: the seller's own SLMC registration on the web POS. That is open PR #109 (see
AC3).
