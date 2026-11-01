# P2 desktop enrollment and online POS client — implementation status

Epic P2 [#48](https://github.com/ShafeekSaleem/PharmaCeylon/issues/48), started 2026-10-30 on the
user's direction. Wire details are in [API_CONTRACT.md](API_CONTRACT.md) ("Desktop enrollment and
staff sessions" and "Offline-counter assignment"); product rules stay in
[POS_V1_CONTRACT.md](POS_V1_CONTRACT.md) and [POS_V1_REVIEW.md](POS_V1_REVIEW.md).

## Built

| Area | API (`apps/api`) | Desktop (`apps/pos-desktop`) |
| --- | --- | --- |
| Enrollment | `/terminals` routes over P1's `TerminalTrustService`; manager-at-the-computer or one-time enrollment code (`terminal_enrollment_code`, SHA-256 only, single use, consumed with the enrollment) | Ed25519 key generated in main, PKCS#8 in SQLCipher (`device_identity`), pending row saved before finish so a lost response never strands the key |
| Local attendance | `terminal_attendance_proof` + production `LocalAttendanceVerifier`; only the physical console session, bound to one challenge, consumed once in the caller's transaction | Windows session read through koffi (`ProcessIdToSessionId`, `WTSGetActiveConsoleSessionId`, `SM_REMOTESESSION`, `WTSClientProtocolType`); signed `LocalAttendanceAttestation` |
| Staff sessions | Session challenge/finish/end; a new session supersedes an older open binding on the till | Sign in, switch user, sign out, enrollment status refresh, revoked counters stop |
| PINs (D-W5) | `posPinVersion`, `terminal_staff_preparation`; set/change at the counter with the password, prepare with the co-sign lockout | scrypt verifier per person and version (`staff_credential`), lock/unlock offline with a persisted throttle |
| D13 activation | `terminal.activate_offline`; signed, attended activation on the exact target; `requireCurrent`; D11 clearance port; separate authorizer/activator audit | Offline counter panel shows a waiting authorization and activates it |
| Go-live evidence (D-W1) | `terminal_test_receipt`; checklist and setup readiness count prepared staff (current PIN version) and confirmed receipts on active counters | "Yes, the receipt came out" after a test print |
| Online checkout | `x-terminal-session` attribution on `POST /sales/checkout` (`sale.terminal_id/till_id/work_session_id`) | Server-priced cart, cash/card/split tender, crash-safe drafts (`checkout_draft`) confirmed by idempotent resend, receipts, held carts |
| Physical execution | (P1 executor) | `SignedCommandService` with stored envelopes (`signed_command`); remote-approved refunds executed at the counter showing requester, approver and executor |
| Readiness | — | Device enrollment, prepared staff, unconfirmed sales/actions |
| Prescriptions and co-sign | Checkout refusals coded `PRESCRIPTION_REQUIRED` / `PHARMACIST_APPROVAL_REQUIRED` | Link a customer and prescription (find or record), pharmacist co-sign by PIN for controlled items; the PIN is sent once and never stored (the draft keeps the co-signer only, migration 0006); holds carry the customer and prescription |
| Web (W6, W3) | `GET /admin/users/:id/security` adds PIN version and prepared counters | Settings → Counters & devices: counters, enrolled computer, issue and revoke codes, report lost, retire. Users → Manage staff: PIN state, version, prepared and stale counters, reset for every role |

## Verification

- API: `npm run lint -w api`, unit suite, and PostgreSQL suites
  `terminal-enrollment.int-spec.ts` and `offline-activation.int-spec.ts`. These run against the
  real attendance verifier, with nothing stubbed. They cover remote sessions, wrong bindings,
  replay, rollback, codes, PINs, supersession, D13/D11, go-live evidence and the
  last-unit race across two counters.
- Desktop: jest specs for the key, Windows session classification, the API client, enrollment,
  sessions, PINs, activation, checkout drafts, holds and signed commands. Typecheck and
  `electron-vite build` also pass. The koffi reader was exercised on a real Windows console
  session.

## Not done in P2 yet

- **Clinical verification beyond the existing checkout rules.** The counter links and records
  prescriptions and takes the pharmacist co-sign the server already enforced for the web POS.
  Fuller clinical capture (dose checks, dispensing labels) belongs with W5.
- **D8 acknowledgement and assisted-handover capability preparation.** These need P3 grants and
  P4 shifts.
- **D11 replacement clearance evidence.** The first nomination works. Replacing a nominated
  counter fails closed until P3 grant cutoff and P5 journal review supply evidence.
- **Windows packaging smoke.** The full enroll, sign-in, restart and print run on packaged
  hardware is still to do. Electron's binary download is blocked by npm 11's install-script
  policy on the development machine.
- **Web D13 authorization screen.** Owners still authorize an offline counter's assignment
  through the P1 endpoint; W6 has no button for it yet. The installer download link is also W6.
