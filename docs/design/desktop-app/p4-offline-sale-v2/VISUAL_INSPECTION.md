# Visual inspection — P4 offline sale v2

Checked 17 November 2026, Asia/Colombo. Playwright overflow and 1600×1000 size checks were clean on every light and dark frame.

- `d-done`: the on-screen customer receipt is a normal till receipt (pharmacy, address, 17 Nov 2026, 16:20, C1R-000186, lines, cash, change, “Thank you · Prices include tax”). No “Offline sale” or “pending upload” on the paper. The cashier still sees a banner, a Pending upload chip on last sale, and “4 to send” in the title bar.
- `d-clean`: last sale shows only C1R-000186, a plain Uploaded state, and Reprint. Banner says the receipt number is unchanged. No second INV- number.
- `w-dash`: normal dashboard (sales today, bills, decisions, low stock). No offline mode or offline KPI. Today's priorities mixes a purchase order, a refused journal entry, a payout, a stock case, a near-expiry batch and a late receiving row. Quiet Offline sync / Stock safety tags. Only “late · 2 days” is coloured. Neutral chips, All filled. One-line “waiting at the counter” note.
- `w-journal` and `w-case`: ordinary detail pages with a Dashboard · Today's priorities crumb. Receipt shown as C1R-000185. No offline-mode chrome.
- Cosmetic, not blocking: on the completed-sale receipt dialog, a few letters of the empty-ticket prompt remain visible at the edge of the scrim (same as v1).
