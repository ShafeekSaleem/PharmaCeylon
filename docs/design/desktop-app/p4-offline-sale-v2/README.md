# P4 offline sale mockups, v2

These are Zendaya's mockups for offline selling on the desktop counter (issue #50), dated 17 November 2026. Shafeek approved them on 18 November 2026.

- `SPEC.md` describes the screens and the contract questions they raised.
- `VISUAL_INSPECTION.md` records the design checks.
- `index.html` is the review page. Open it with `?theme=light|dark|both` or `?full=<screen-id>`.
- The PNGs are 1600×1000 frames. Files starting `d-` are desktop screens and files starting `w-` are web screens. Each one has a light and a dark version.

## Where the build differs from the drawings

Shafeek answered the contract questions on 18 November 2026 (#50). The build follows those answers wherever a drawing says something else:

| Screen | Drawing | Build |
| --- | --- | --- |
| `d-cart` | Shows Hold with "Needs an online connection". | The same. Hold is blocked while offline (Q2). |
| `d-stock` | The cashier's banner explains that a stocktake counted the sale. | The cashier sees only "Stock under review". The reason is shown to managers in the back office and on Counter work, where the plan is carried out (Q3). |
| `d-review` | "Checkout can continue online once fresh stock is installed." | The counter stays paused until a manager settles the refused entry on the web. The journal is an ordered hash chain, so nothing after a refused entry can be accepted (Q4, corrected). |
| `w-dash` | The refused-entry row is shown to `tenant.management`. | The row is gated on `sales.review_offline_entries` and opens the entry on Offline records (Q5). |

## Not drawn yet

- Settings › Offline selling.
- The after-hours manager acknowledgement (D8). Its main-process part is in #211.
