# P6 Counter work operation screens

Mockups for the desktop screens that P6 ([#52](https://github.com/ShafeekSaleem/PharmaCeylon/issues/52)) still has to build inside the Counter work frame (#122): every row marked `planned` in [`docs/COUNTER_WORK_COVERAGE.md`](../../../COUNTER_WORK_COVERAGE.md). Drawn 20 November 2026. **Not approved yet:** nothing here should be built until Shafeek signs it off and answers the questions in `SPEC.md`.

- `SPEC.md` lists each screen, the API call behind it, and the questions the drawings raised.
- `index.html` is the review page. Open it with `?theme=light|dark|both` or `?full=<screen-id>`.
- The PNGs are 1600×1000 frames, `d-<screen-id>-light.png` and `d-<screen-id>-dark.png`.

| # | Screen id | Counter work kind | Signed call |
| --- | --- | --- | --- |
| 1–3 | `rcv`, `rcv-mismatch`, `rcv-changed` | `prepared_receipt` | `POST /purchasing/prepared-receipts/:id/post` |
| 4 | `held` | `held_delivery` | `POST /purchasing/held-deliveries/:id/post` |
| 5–7 | `tship`, `tship-retry`, `tship-done` | `transfer_ship` | `POST /transfers/:id/ship` |
| 8 | `trecv` | `transfer_receive` | `POST /transfers/:id/receive` |
| 9 | `stk` | `stocktake` | `POST /stocktakes/:id/post` |
| 10 | `sret` | `supplier_return` | `POST /returns/:id/complete` |
| 11 | `imp` | `import_stock` | `POST /products/import/:importId/stock/post` |
| 12 | `imp-undo` | (`import_undo` destination) | `POST /products/import/:importId/undo-stock` |

These replace the Receive goods drawing on the `work` screen of `pharmaceylon-pos-desktop.html` where they differ. That drawing let the counter change a received quantity and type a batch; the post sends only the approval, so the counter can't (see Q1). The cold-chain tag stays in P8 #104.

The style follows the P4 offline-sale mockups (`../p4-offline-sale-v2/`) and UI1 #205: a queue card's title is its next action, it has one quiet state chip, and colour marks only the exception.
