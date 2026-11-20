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
| `supplier_cash_payout` | `supplier_cash_payout.execute` | `POST …/cash-payouts/:id/execute` | `supplier_payout` | **available** (#187, on Cash & shift) |
| `stocktake` | `stocktake.post` | `POST …/stocktakes/:id/post` | `stocktake` | planned |
| `held_adjustment` | `held_adjustment.post` | `POST …/held-adjustments/:id/post` | `held_write_off` | **available** (#173) |
| `supplier_return` | `goods_return.complete` | `POST …/returns/:id/complete` | `supplier_return` | planned |
| `import_stock` | `import_stock.post` | `POST …/import/:importId/stock/post` | `import_post` | planned |
| `stock_case` | `offline_stock_case.resolve` | `POST …/resolutions/:id/execute` | `offline_stock_case` | **available** (P5 #51) |

Planned destinations still appear in Counter work with `task.nextAction.executable: false` until P6
ships the operation screen inside the #122 frame.

## Desktop display (#172 Stage 2)

The counter shows, per item, the approval state (pill and trail), the next action (from
`task.nextAction`; planned screens say the screen comes next and offer no action) and when the
list was last checked (`task.freshness.asOf`). When the counter is offline or the last check
failed, the last list stays on screen read-only with its check time, and every action on the page
is off until a fresh list arrives. Rows whose `task.freshness.stale` is true are held like a
changed approval.

## Related physical operations not listed here

These use signed commands but are not web-approved queue rows on this endpoint:

| Flow | W11 kind (if any) | Signed operation | P6 destination | Notes |
| --- | --- | --- | --- | --- |
| Import undo | — | `POST …/import/:importId/undo-stock` | `import_undo` | Not a counter-work list kind; listed by `GET /counter-work/imports` (P6 decision 5) |
| Quarantine / release | `batch.expiry_review` (daily work) | `POST …/batches/:id/quarantine`, `release-quarantine` | `quarantine`, `release_quarantine` | #173 contract; daily work browser route unchanged |
| Direct adjustment / write-off | — | `POST …/inventory/adjustments` | Stock (ad hoc) | Held over-limit uses `held_adjustment` row above |

## Surfaces

| Surface | Role |
| --- | --- |
| Web Daily work | Discovery and approval; `where: counter` for kinds above |
| `GET /counter-work` | Executable documents plus read-only held write-offs (`awaiting_approval`; `rejected` for `COUNTER_REJECTED_HELD_WRITE_OFF_VISIBLE_DAYS`) |
| `GET /counter-work/:kind/:id` | P6 counter read: one item's lines, trail and notes (see below) |
| `GET /counter-work/imports` | P6 decision 5: imports this counter can still undo, with the stock each posted |
| `GET /dashboard/counter-attention` | Counter route only: `batch.expiry_review` rows with `counterExecution` (signed quarantine, `reasonCode: expired`) |
| `GET /tenant/my-permissions` | Effective permission keys at the branch for counter UI hints (`@CounterRoute()`) |
| P6 desktop | Physical execution screens mapped by `task.destination` |

Permissions match #122: each kind is listed only when the caller holds that operation's permission
at the branch (`terminal.execute` gates the route).

## Counter reads (P6 #52)

The document detail routes are web routes and refuse a PIN-opened counter login, so the
operation screens read the document they are about to confirm from `GET /counter-work/:kind/:id`.
Types: `CounterWorkDetail` in `packages/shared/src/counter-work.ts`; service:
`terminal-commands/counter-work-detail.service.ts`.

- **Kinds:** `prepared_receipt`, `held_delivery`, `transfer_ship`, `transfer_receive`,
  `stocktake`, `supplier_return`, `import_stock` (`COUNTER_WORK_DETAIL_KINDS`). Refunds and
  offline stock cases already have counter reads of their own; held write-offs and cash payouts
  carry everything on the list row. Any other kind is a 400.
- **Same gate as the list.** The read goes through `CounterWorkService.one`, which fetches with
  the list's own query plus the id. 403 without the kind's execute permission at the branch;
  404 once the document has left this branch's queue (posted, cancelled, another branch). The
  header (`approval`, `task`, people) is exactly what the list reports for that item.
- **Costs** (`unitCost`, `packCost`, `amount`, `valueAtCost`, `unitPrice`) are null without
  `costs.view`.
- **Stocktake** lines are in decision 3's terms: `onHandAtCount` (snapshot + movements before
  the count), `difference` (counted − on hand at count), `now` (+ movements after the count),
  `afterPost` (now + difference). Uncounted lines have a null difference and post nothing.
- **Opening stock** returns rows and per-category totals; a category is `posted` once all its
  rows are. Posting a category sends its `categoryName`.

`GET /counter-work/imports` lists imports uploaded at this branch with their stock that still
pass the undo checks: completed or stopped (`failed`, which `undo` accepts), with
`product_import` rows in the stock ledger (not `batchesCreated`, which a stopped run never
writes), not posted from staging, and nothing from them sold or moved. `stopped` marks a stopped
run, and `createdProducts` lists the catalogue entries undo removes, including any the import
gave no stock. The web's import list decides "has stock" the same way, so every import it sends
to the counter is listed here. At most 50, counted after the undo checks. It is empty without
`products.import`.

The header and the lines are separate reads, so the detail re-reads the document's version
after building the lines and retries once if it moved (409 if it moves again): a header for one
approved version is never paired with another version's lines. Receipt lines resolve units per
pack, quantity and unit cost exactly as receiving posts them (`purchasing/pack-math.ts`, then
the order line and the supplier's price).

## Signed evidence pinning

| Kind | `task.signedExecution.approvalEvidenceId` | `task.signedExecution.dispatchApprovalId` |
| --- | --- | --- |
| All except `transfer_receive` | evidence when `approval.state` is `matches` | always `null` |
| `transfer_receive` | always `null` | transfer `executionApprovalId` when not blocked (`null` when waived) |

## Offline

Counter work list and all signed executions require `terminalConnectivity: online`. With
`partial_outage`, clients show the last list as read-only using `task.freshness.asOf` and must not
treat cached rows as centrally completed.

### The nominated counter during an outage (P4 #50, W11 #145)

**Task identity: there is no local task.** Every row in Counter work and web Daily work is a
central task with a server ID. The counter never creates, edits or completes a task while
offline. That is why reconnecting cannot duplicate a task or complete one early: there is no local
copy to merge.

**What the counter keeps locally instead.** This is evidence, keyed by its own IDs, and it is never
shown as a task:

| Kept locally | Its ID | Shown on the counter | What it becomes centrally |
| --- | --- | --- | --- |
| Offline sales and shift open/close | Journal sequence and hash, `commandId` | Upload queue, reconnect notice | Sales and shifts, replayed once. Refused entries become an Offline sync row in Daily work. |
| External-card attempts | `attemptId` | Sell (an open card is restored; see below), This counter → offline records | Card evidence; `card_not_used` for a manager |
| Notes on a sale | `recordId` | This counter → offline records | Incident evidence |

**Freshness.**
- While selling offline, the nominated counter shows no Counter work page at all.
- A counter that is disconnected but not selling offline keeps its last list read-only with its
  check time, as described above.
- After an outage, checkout stays paused (D12) until the journal has been accepted, open card
  attempts are settled and fresh stock is installed. Counter work is then read from the server
  again. It replaces the old list; it is not merged into it.
- Any stock case or review the outage caused arrives from the server as an ordinary task, such as
  `stock_case` or an Offline sync row.

**Restart, outage and reconnect.**

| Case | Behaviour | Covered by |
| --- | --- | --- |
| Upload replayed or retried | Each entry is applied once, and a retry returns the original receipts. | `offline-journal.int-spec.ts`: "replays … once", "concurrent identical retries" |
| Stock case run again | Executes once; a retry returns the original receipt. | `offline-stock-cases.int-spec.ts`: "executes once under concurrent retries" |
| App restart with a card still on the machine | The card and its cart come back on Sell. The drain stays held until the card is settled. | `offline-sale.spec.ts`: "keeps a card left on the machine across a restart" |
| Counter offline, or a check failed | The last list stays read-only, and nothing on it can be acted on. | `CounterWork.spec.tsx`: "offline, keeps the last list read-only" |

Still to verify on a real counter: the same cases after an OS reboot and a power cut.
