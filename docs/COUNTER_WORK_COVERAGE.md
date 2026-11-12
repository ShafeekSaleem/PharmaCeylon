# Counter work: W11/P6 coverage matrix (#172)

Restricted counter projection: `GET /api/v1/counter-work`. Source of truth for kinds, daily-work
mapping and P6 desktop destinations is `packages/shared/src/counter-work.ts`.

## Executable kinds on the counter

| Counter-work `kind` | W11 `dailyWorkKind` | Signed `operation` | P6 `destination` | Desktop screen status |
| --- | --- | --- | --- | --- |
| `prepared_receipt` | `prepared_receipt.post` | `POST …/prepared-receipts/:id/post` | `receiving` | planned |
| `held_delivery` | `held_delivery.post` | `POST …/held-deliveries/:id/post` | `held_delivery` | planned |
| `transfer_ship` | `transfer.ship` | `POST …/transfers/:id/ship` | `transfer_ship` | planned |
| `transfer_receive` | `transfer.receive` | `POST …/transfers/:id/receive` | `transfer_receive` | planned |
| `refund` | `sale_refund.execute` | `POST …/refund-requests/:id/execute` | `refund` | **available** |
| `stocktake` | `stocktake.post` | `POST …/stocktakes/:id/post` | `stocktake` | planned |
| `held_adjustment` | `held_adjustment.post` | `POST …/held-adjustments/:id/post` | `held_write_off` | planned |
| `supplier_return` | `goods_return.complete` | `POST …/returns/:id/complete` | `supplier_return` | planned |
| `import_stock` | `import_stock.post` | `POST …/import/:importId/stock/post` | `import_post` | planned |
| `stock_case` | `offline_stock_case.resolve` | `POST …/resolutions/:id/execute` | `offline_stock_case` | planned |

Planned destinations still appear in Counter work with `task.nextAction.executable: false` until P6
ships the operation screen inside the #122 frame.

## Related physical operations not listed here

These use signed commands but are not web-approved queue rows on this endpoint:

| Flow | W11 kind (if any) | Signed operation | P6 destination | Notes |
| --- | --- | --- | --- | --- |
| Import undo (non-live branch) | — | `POST …/import/:importId/undo-stock` | `import_undo` | Not a counter-work list kind |
| Quarantine / release | `batch.expiry_review` (daily work) | `POST …/batches/:id/quarantine`, `release-quarantine` | `quarantine`, `release_quarantine` | #173 contract; daily work browser route unchanged |
| Direct adjustment / write-off | — | `POST …/inventory/adjustments` | Stock (ad hoc) | Held over-limit uses `held_adjustment` row above |

## Surfaces

| Surface | Role |
| --- | --- |
| Web Daily work | Discovery and approval; `where: counter` for kinds above |
| `GET /counter-work` | Approved documents waiting at this branch's counter only |
| P6 desktop | Physical execution screens mapped by `task.destination` |

Permissions match #122: each kind is listed only when the caller holds that operation's permission
at the branch (`terminal.execute` gates the route).

## Signed evidence pinning

| Kind | `task.signedExecution.approvalEvidenceId` | `task.signedExecution.dispatchApprovalId` |
| --- | --- | --- |
| All except `transfer_receive` | evidence when `approval.state` is `matches` | always `null` |
| `transfer_receive` | always `null` | transfer `executionApprovalId` when not blocked (`null` when waived) |

## Offline

Counter work list and all signed executions require `terminalConnectivity: online`. With
`partial_outage`, clients show the last list as read-only using `task.freshness.asOf` and must not
treat cached rows as centrally completed.
