# P2 desktop enrollment and online POS client — implementation status

Epic P2 [#48](https://github.com/ShafeekSaleem/PharmaCeylon/issues/48), started 2026-10-30 on the
user's direction. Wire details are in [API_CONTRACT.md](API_CONTRACT.md) ("Desktop enrollment and
staff sessions" and "Offline-counter assignment"); product rules stay in
[POS_V1_CONTRACT.md](POS_V1_CONTRACT.md) and [POS_V1_REVIEW.md](POS_V1_REVIEW.md).

## Built

| Area | API (`apps/api`) | Desktop (`apps/pos-desktop`) |
| --- | --- | --- |
| Enrollment | `/terminals` routes over P1's `TerminalTrustService`; manager-at-the-computer or one-time enrollment code (`terminal_enrollment_code`, SHA-256 only, single use, consumed with the enrollment); an occupied counter is 409 `COUNTER_OCCUPIED` | Ed25519 key generated in main, PKCS#8 in SQLCipher (`device_identity`), pending row saved before finish so a lost response never strands the key |
| Local attendance | `terminal_attendance_proof` + `LocalAttendanceVerifier`, the **accepted v1 attendance control** (D-P2a, below); only the physical console session, bound to one challenge, consumed once in the caller's transaction | Windows session read through koffi (`ProcessIdToSessionId`, `WTSGetActiveConsoleSessionId`, `SM_REMOTESESSION`, `WTSClientProtocolType`); signed `LocalAttendanceAttestation`; refuses while a known remote-control tool is running |
| Staff sessions | Session challenge/finish/end; a new session supersedes an older open binding on the till | Sign in, switch user (the new password is checked first), sign out, enrollment status refresh, revoked counters stop |
| PINs (D-W5) | `posPinVersion`, `terminal_staff_preparation`; set/change at the counter with the password (login's lockout applies), prepare with the co-sign lockout; the old web PIN routes refuse at live branches | scrypt verifier per person and version (`staff_credential`), lock/unlock offline with an uptime-based, escalating lockout |
| D13 activation | `terminal.activate_offline`; signed, attended activation on the exact target; `requireCurrent`; D11 clearance port; separate authorizer/activator audit | Offline counter panel shows a waiting authorization and activates it |
| Go-live evidence (D-W1) | `terminal_test_receipt`; checklist and setup readiness count prepared staff (current PIN version) and confirmed receipts on active counters | "Yes, the receipt came out" after a test print |
| Online checkout | `x-terminal-session` attribution on `POST /sales/checkout` (`sale.terminal_id/till_id/work_session_id`); mandatory selling windows (W7) enforced on counter sales; overlapping retries of one key replay the original | Server-priced cart with the VAT-inclusive total, a tender covering it, cash/card/split, crash-safe drafts (`checkout_draft`) confirmed by idempotent resend, receipts, held carts |
| Physical execution | (P1 executor) | `SignedCommandService` with stored envelopes (`signed_command`); remote-approved refunds executed at the counter showing requester, approver and executor |
| Unconfirmed sales | `POST /sales/checkout/resolve`: someone else at the same enrolled counter looks a seller's unconfirmed checkout up by tenant, branch, enrollment and key, under the checkout's own key lock. It returns the committed sale, or says "never landed" and seals the key (`checkout_sealed`, later checkout 409 `CHECKOUT_SEALED`) | The seller resends; anyone else signed in looks it up and never resends. Sell's pending list says who started each sale |
| Readiness | — | Device enrollment, prepared staff, unconfirmed sales/actions: who started each sale (anyone here can confirm it) and who must confirm each action |
| Prescriptions and co-sign | Checkout refusals coded `PRESCRIPTION_REQUIRED` / `PHARMACIST_APPROVAL_REQUIRED` / `APPROVER_NOT_QUALIFIED` / `SELLER_NOT_QUALIFIED`; wrong co-sign secrets are 403. The dispenser's SLMC registration is checked in the checkout transaction and kept on the sale; approvers are registered pharmacists only (P1 MR 10b) | Link a customer and prescription (find, or record through the signed clinical command), pharmacist co-sign by PIN for controlled items; the PIN is sent once and never stored (the draft keeps the co-signer only); holds carry the customer and prescription |
| Till shifts (P2b #103) | `till_shift` (one open per till, partial unique index; immutable once closed), `till_cash_movement`; open with own PIN and a note-and-coin count, close by the owner or a manager's assisted close (`shifts.close_others`); counter sales and cash refunds carry `shift_id` (D-P2b-shift) | `ShiftService` keeps the till's shifts in SQLCipher (local migration 0012): whose shift is open, the counter's own running expected cash (D7b), and whether the server confirmed the last open or close. A close is saved with its command ID before it is sent and resent under that ID after a restart; no PIN is stored. Sell is covered until the signed-in person's own shift is open; the status bar shows the shift and the drawer; the lock screen shows "Shift open since" and the handover note; Cash & shift opens and closes shifts (P2b #103) |
| Web (W6, W3) | `GET /admin/users/:id/security` adds PIN version and prepared counters | Settings → Counters & devices: counters, enrolled computer, issue and revoke codes, report lost, retire. Users → Manage staff: PIN state, version, prepared and stale counters, reset for every role |

## Decisions

**D-P2a — attendance (decided by Shafeek, 2026-11-01).** Shafeek accepted the documented limits
for v1 (option 3 of the question this section used to ask). The device-signed attestation of the
physical console session is the v1 attendance control. Remote Desktop is refused. Third-party
remote-control tools (AnyDesk, TeamViewer, Chrome Remote Desktop and similar) are a known,
accepted limit: the desktop refuses while a known one is running, but a renamed process passes.
Named staff attribution, audit and training remain the control. No TPM or hardware anchor is
needed for v1. Recorded in [POS_V1_REVIEW.md](POS_V1_REVIEW.md) and in API_CONTRACT.md's "Limits".

**Co-sign attendance (v1 rule).** A controlled-item co-sign at checkout relies on the attendance
proved when the seller's staff session opened at that counter, not on a fresh proof bound to the
sale. Binding a `command`-purpose proof to co-signed checkouts is a possible later tightening.

**SLMC registration at the counter (P1 MR 10b, 2026-11-03).** This changed P2's dispensing flow
after #93 merged; details are in [POS_P1_IMPLEMENTATION.md](POS_P1_IMPLEMENTATION.md) MR 10b.
- Whoever dispenses controlled items needs a current SLMC registration at the branch: the PIN
  co-signer, or the seller when nobody co-signs. A named co-signer is the dispenser even if the
  seller could dispense alone. The co-sign picker lists only registered pharmacists.
- Confirming an unanswered sale: `APPROVER_NOT_QUALIFIED` and `SELLER_NOT_QUALIFIED` are final, so
  the draft is marked refused instead of waiting for a co-signer whose registration has lapsed.
- An unanswered prescription command shows straight away in "Waiting at the counter".
- The desktop records a prescription through the signed `POST /api/v1/prescriptions` command
  (`SignedCommandService`), not the unsigned route, which now refuses at live branches outside a
  fallback (`PRESCRIPTION_AT_COUNTER`). So a cashier can't record one: the registered pharmacist
  switches in and records it. Finding and linking an existing prescription is unchanged.

**D-P2b-shift — sales attach to the shift directly (P2b #103, 2026-11-04).** The contract defines
the work session as the staff shift; `TerminalStaffSession` is only who is signed in. The two
don't line up: the person who opened a shift locks, unlocks and switches back in during it (each a
new or superseding sign-in), and a manager's assisted close is a sign-in by someone else on that
shift. So:
- `till_shift.id` **is** D7b's `workSessionId`: generated on the counter, the identity
  `shift_open` / `shift_close` carry, the same record P4 writes offline and P5 replays. The online
  sign-in maps to D7b's `OfflineStaffSignIn`, not to the work session.
- `sale.shift_id`, `sale_payment.shift_id` and `goods_return.shift_id` reference the shift
  directly. A sale's own payments carry the sale's shift; a refund's negative payments carry the
  refund's shift, which can be a later one, so expected cash is a sum over the shift's own rows.
- `sale.work_session_id` keeps naming the sign-in, as before (renaming it would touch every reader
  of counter sales while other P2b sessions are in flight). Read it as "signed in as", and
  `shift_id` as the D7b work session.
- Every counter sale belongs to exactly one shift: checkout share-locks the seller's own open
  shift on that till and refuses without one (`SHIFT_REQUIRED`, `SHIFT_HELD_BY_OTHER`). A cash
  refund executed at a counter does the same on the executor's shift. Closing takes the row
  `FOR UPDATE`, so it waits for in-flight sales, and nothing lands on a closed shift.
- Web POS sales and refunds have no till and carry no shift.

**Mandatory hours (D-W6).** Counter checkout refuses outside the branch's mandatory selling
windows. Routine closing time stays advisory online; revised D8's acknowledgement is an offline
matter (P3/P4). A branch with no hours set has no restriction; stored hours that can't be read
fail closed.

**Confirming another seller's sale (2026-11-04).** This closes the epic's "a manager can't
confirm another seller's unconfirmed sale", which conflicted with "no hidden single-original-cashier
restriction".
- **Lookup, never a resend.** Someone other than the seller never resends the sale. A resend under
  their own key would be a new sale attributed to them, and the seller's key can't be borrowed.
  `POST /sales/checkout/resolve` finds the original by the key and session the draft recorded.
  The session must be at this branch and on the caller's enrollment.
- **"Never landed" is definite.** The lookup takes checkout's own key lock
  (`sales/checkout-lock.ts`), so an original still in its transaction commits or rolls back first.
  When nothing is there, the lookup seals the key in the same transaction, and checkout checks for
  the seal under that lock. An original that was still on its way is refused when it arrives,
  instead of landing after the counter rang the sale up again. A slow original already in its
  transaction also holds the counter's enrollment lock, so a colleague can't even sign in at that
  till until it finishes.
- **Who may confirm: anyone with `sales.pos_use` signed in at that counter.** A manager-only rule
  would keep a sale waiting at a counter run by two cashiers. The lookup moves nothing, attributes
  nothing to the caller and answers only for the counter's own sales, and it is audited
  (`sale.checkout_resolved`). Proposed for Shafeek to agree in the PR.
- **Desktop.** `CheckoutService.retry` resends for the seller and looks up for anyone else. "Never
  landed" marks the draft refused (`CHECKOUT_NEVER_LANDED`) and asks for the sale to be rung up
  again. A lookup with no answer, or one refused before the lookup, leaves the draft pending. A
  colleague's lookup asks for no co-sign PIN. Sell's pending list says "rung up by you" or "started
  by <name>".

## Verification

- CI runs `npm run lint` (typechecks every workspace), the API unit suite, the PostgreSQL suites
  (`terminal-enrollment.int-spec.ts`, `offline-activation.int-spec.ts` and the rest), web
  component tests and now the desktop suite (`npm test -w pos-desktop`).
- The PostgreSQL suites run against the real attendance verifier, with nothing stubbed. They cover
  remote sessions, wrong bindings, replay, rollback, codes, PINs, supersession, D13/D11, go-live
  evidence, the last-unit race across two counters, overlapping retries of one checkout key,
  occupied counters and mandatory hours. `checkout-resolution.int-spec.ts` covers confirming
  another seller's sale: landed, never landed (and the late original refused), a slow first
  attempt racing the lookup, the key lock, and another counter, branch or session refused.
- Desktop specs cover the key, Windows session classification, remote-tool detection, the API
  client (shared refresh, coded 401s), enrollment, sessions, PINs and the lockout, activation,
  checkout drafts, tender, holds and signed commands, including the signed prescription command and
  its refusals. `electron-vite build` passes. The koffi reader and `tasklist` were exercised on a
  real Windows console session.

## Before a branch goes live on this

- **Windows packaged smoke run (acceptance criterion).** Not done yet. It needs a packaged build
  on real Windows hardware with a receipt printer, driven by a person:

  enroll (manager and code paths) → sign in → set and prepare PIN → lock and unlock → switch user
  → sale with receipt → restart the app → restart Windows → sign in again → confirm a test receipt

  Record the date, machine, build and result here. `npm install-scripts approve electron` (npm 11)
  unblocks Electron's binary download; koffi loads without its install script.

## Known limits in this PR

- **Only the person who sent an unconfirmed signed action can confirm it.** Sales no longer have
  this limit (see "Confirming another seller's sale"). A signed command is still resent by its
  sender, so readiness names who must come back for each.
- **Remote-control detection is by process name.** It stops the casual case only (see D-P2a).
- **Only a registered pharmacist signed in at the counter can record a prescription.** A signed
  command takes no co-sign evidence yet, so a cashier asks the pharmacist to switch in. Nobody can
  co-sign or record until an owner has recorded registrations, and no screen does that yet
  (`POST /admin/pharmacist-registrations`).

## Not done in P2 yet

- **Desktop screens for the other nine signed physical operations** (P6's desktop half, or a P2
  follow-up). The server already requires a signed counter command for stocktake post, held
  adjustment post, held delivery post, import stock post and undo (D-W2 opening stock), transfer
  ship and receive, prepared receipt post and supplier return complete. `SignedCommandService`
  can drive them all, but only refunds have a screen, so a live branch can't do these at the
  counter until it lands.
- **D8 after-hours acknowledgement and offline assisted handover.** Need P3 grants and P4's offline
  journal. Online shifts and the online assisted close exist (P2b #103, D-P2b-shift).
- **D11 replacement clearance evidence.** The first nomination works. `recoveryEvidence` returns
  false, so replacing a nominated counter fails closed until P3 grant cutoff and P5 journal review
  supply evidence.
- **Offline sign-in evidence and local shift IDs (P3/P4 hand-off).** `terminal_staff_preparation`
  with PIN versions is the base, but the offline sign-in evidence a P3 grant will carry, and P4
  creating shift IDs locally, aren't defined yet.
- **Pre-outage readiness (P3/P4).** Shown today: enrollment, prepared staff, unconfirmed work.
  Still to come: stock sync age, grant expiry, storage and clock health, unresolved collected
  money.
- **Discounted-cart review before offline tender (P4).** The crash-safe draft is done.
- **Web D13 authorization screen and installer download link (W6).** Owners still authorize an
  offline counter's assignment through the P1 endpoint.
- **Fuller clinical capture (W5).** The counter links and records prescriptions and takes the
  pharmacist co-sign; dose checks and dispensing labels belong with W5.
