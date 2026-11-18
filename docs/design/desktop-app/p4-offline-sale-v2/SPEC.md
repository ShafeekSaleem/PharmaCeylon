# P4 · Offline sale mockups v2

17 November 2026, Asia/Colombo. Fixture clock: Tuesday, 17 November 2026, 16:20.

Mockups only. No product code, no PRs, nothing sent. Direction needs Shafeek’s approval before any UI build. v1 at `/workspace/pharmacylon-design/p4-offline-sale-2026-11-17/` is untouched.

Audited against `develop` `4339d46`, issue #50 (comment `6945664998`), UI epic #205, and the signed contracts in `packages/shared/src/terminal-contracts.ts`, `offline-sale-commit.ts`, `daily-work-kinds.ts`, and the desktop journal sync / reconnect drain.

Review: `index.html` (`?theme=light|dark|both`, `?full=<screen-id>`). Desktop frames are 1600×1000. Light is the primary frame; every screen also has dark from the same tokens.

## Changes from v1

1. **Web has no offline mode.** There is no separate offline dashboard, banner, or “Counter 1 is offline” KPI. `offline_journal.review` and `offline_stock_case.review` appear in the existing Today's priorities work queue as ordinary items among other work, with the #205 row anatomy (document number, counterparty/counter, value, age; quiet tag; only lateness coloured) and the same neutral chips. `w-journal` and `w-case` are ordinary detail pages opened from those rows (breadcrumb: Dashboard · Today's priorities). A one-line note folds “waiting at the counter” in, per #205.
2. **The customer receipt is a normal receipt.** “Offline sale · pending upload” and any offline or pending wording are gone from the printed and on-screen customer receipt. It shows the pharmacy, date, cashier, receipt number, lines, tender and a thank-you line — the same as an online receipt. Pending/upload state is cashier-only: title-bar count, last-sale chip, queue, and a toast/banner on `d-done`.
3. **The customer-facing number is final at print time.** Option A (recommended): C1R-000186 *is* the receipt number and never changes. The server may store it and link an internal INV- or id, without reprinting a different number or putting that id on the customer's receipt. Option B (server INV- only) is presented honestly: that number does not exist at print time while the counter is offline, so a final receipt cannot be produced then. v1 Q2 (reprint showing both C1R- and INV-) is dropped; Q1 is rephrased around a permanent number.

Everything else is as v1 (#205 Sell anatomy, title-bar-only sync, blocked actions, drain, settlement outcomes, tokens, no new API fields).

## Screens

Desktop (Counter 1 unless noted): `d-enter`, `d-cart`, `d-done`, `d-queue`, `d-blocked`, `d-other` (Counter 2), `d-drain`, `d-clean`, `d-stock`, `d-review`, `d-work`.

Web: `w-dash` (normal dashboard, mixed Today's priorities), `w-journal`, `w-case`.

## Visual rules (#205)

Unchanged from v1: one semantic token set, light and dark; muted text at 4.5:1 (`#575f6e` / `#a3b1c6`); colour only the exception; every coloured chip has a word; sync once in the title bar with a pending count; status bar is cashier, shift, counter, clock; one key-hint footer; Rs on desktop, LKR on web; day-month dates; Sell and list anatomy as in #205 / v1 SPEC.

## Changes from earlier approved packs

As in v1: #205 over last-sync for sync placement (title bar only); #205 over dashboard v6 for neutral filter chips; #205 Sell anatomy over the older desktop-app Sell mock; #205 work queue over the v6 2:1 priorities card. v2 additionally uses the name “Today's priorities” for that #205 queue, because that is where offline review items now sit as ordinary rows.

## Contracts followed (no new API)

Unchanged from v1: ordinary sales only; cash and approved external card including split; nominated terminal; snapshot ≤ 15 minutes at outage start; 24-hour permission; journal `sequence` + `commandId`; stock posting `posted` or `pending_reconciliation`; reconnect drain; daily-work kinds `offline_journal.review` and `offline_stock_case.review` / `.resolve`; the blocked/allowed action list.

The current accept path still mints a new `INV-YYMM-000123`. Screens assume Option A instead, and flag that as a contract question rather than inventing a `receiptNumber` field.

## Recommendation and options

**Receipt identity — Option A recommended (needs Shafeek’s choice).** Print a reserved register receipt number (C1R-000186, from W7 `receiptPrefix`) as *the* customer-facing number at the moment of sale. It is final and never changes. The server stores that number and may link its own INV- or internal id for bookkeeping, without reprinting a different number or showing it on the customer's receipt. This is the only option that lets the counter print a normal-looking, final receipt while offline.

**Option B — server INV- only, not recommended.** The server issues `INV-YYMM-000123` only when it accepts the sale, so an offline sale cannot have that number at print time. The counter would have to withhold the receipt, print a temporary number (which must not later change), or reprint after upload. All of those break “the receipt looks like a normal online receipt, final when it is printed.”

Screens assume A and are badged `Rec. A`.

## Contract questions

Dependent screens are badged rather than inventing fields.

1. **Permanent customer-facing receipt number.** `ordinary_sale` has no `receiptNumber` today. After accept, `offline-sale-commit.ts` currently issues a new `INV-YYMM-000123`. W7 has per-register `receiptPrefix`. Under Option A, is C1R-… the permanent customer-facing number the server must store and link (keeping any INV- internal only, never reprinted on the customer's receipt)?
2. **Hold while offline.** Hold is not in the allowed offline list. Screens disable it. Confirm.
3. **`counted_after_sale` on the counter.** The sync acknowledgement carries `pending_reconciliation` and a case id, not the line reason. May the cashier be shown “counted after the sale”, or only “stock under review” until the case is loaded?
4. **Checkout resume after a refused entry.** If entry 15 is refused and later sales are stuck, does this counter resume online selling once the drain otherwise finishes, while those sales wait on review?
5. **Review permission.** Daily work currently sources `offline_journal.review` under `tenant.management`, with a TODO for `sales.review_offline_entries`. Who should see the dashboard row?

(v1 Q2, about reprint showing both C1R- and INV-, is dropped.)

## Out of scope

Same as v1: Settings › Offline selling, a dedicated D8 after-hours screen, device replacement and D11 recovery.
