# PharmaCeylon API contract (pilot, v1)

Single reference for the web team. The machine-readable contract is the **OpenAPI document** served by the API.

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
| Product import   | `product_import`   | `POST /api/v1/products/import/confirm`            |
| Supplier payment | `supplier_payment` | `POST /api/v1/purchasing/payments`                |

**Semantics**

- First request with a key performs the mutation and records the key → resource id.
- Retries with the **same** key return the **same** resource (replay).
- Reusing a key for a **different** logical operation (e.g. different PO on receive, different transfer id on ship/receive) returns **400** with a clear message—do not silently post twice.

## Sales lifecycle (pilot)

- **Checkout**: `POST /api/v1/sales/checkout` — optional `Idempotency-Key`. Line **tax**: send `taxAmount` per line, or omit to apply **VAT** from server config (see below).
- **Void** (posted → voided, stock restored; elevated roles): `POST /api/v1/sales/:id/void`
- **Refund** (posted → refunded, stock restored): `POST /api/v1/sales/:id/refund`

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
| Stocktake | creator and everyone who entered a count | `POST /stocktakes/:id/approve` |

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
| `GET /inventory/stock-by-product` | `inventory.view` | Adds `availableQty`, `quarantinedQty`, `reservedQty`, `expiredQty`, `expiredBatchCount`, `expiryReviewBatchCount`. New query: `attention=expired\|near_expiry\|quarantined\|reserved\|expiry_review`, `sort=name\|available\|onHand`, `dir=asc\|desc`. |
| `GET /inventory/batches` | `inventory.view` | Per-batch quantities as above; `q` searches batch no / product / SKU. `costPrice` is **null** without `inventory.view_cost`. |
| `GET /inventory/products/:productId/stock` | `inventory.view` | Totals, batches, reservations, incoming transfers, open PO quantity, other branches (branches the caller works at; owners see all), recent movements. |
| `GET /inventory/summary` | `inventory.view` | Adds `availableUnits`, `quarantinedUnits`, `reservedUnits`, `expiredUnits`, `expiryReview`, `incomingTransfers`. `stockValue` is **null** without `inventory.view_cost`. |
| `GET /inventory/movements` | `inventory.view` | Filters `productId`, `batchId`, `category` (adds `stocktakes`, `opening`, `quarantine`), `userId`, `from`/`to` (tenant-local dates), `referenceType`/`referenceId`. Quarantine moves appear once with `qtyDelta: 0` and a signed `quarantineDelta`; legacy reservation rows are hidden. `balanceAvailable` says whether before/after balances are meaningful (one product or batch, no other filters). |
| `GET /inventory/movement-actors` | `inventory.view` | Users who moved stock at the branch in the last year. |
| `POST /inventory/batches/:id/quarantine` | `inventory.quarantine` | Body `{ qty?, reasonCode: expired\|damaged\|recall\|inspection\|other, reason? }`. `qty` defaults to everything not already held or reserved; `reason` required for `other`. |
| `POST /inventory/batches/:id/release-quarantine` | `inventory.release_quarantine` | Body `{ qty?, reason? }`. Refused for expired batches. |
| `POST /inventory/quarantine-expired` | `inventory.manage_bulk` | Holds every sellable unit on expired batches. Returns `{ quarantined, units, batchIds }`. |
| `POST /inventory/adjustments` | `inventory.manage` (increase) / `inventory.write_off` (decrease) | Decreases require `reason`; `fromQuarantine: true` writes off held units. |

`POST /inventory/customer-returns` and `POST /inventory/supplier-returns` (which answered 410) have been removed, with the `inventory.customer_returns` permission. Use POS refunds and `POST /returns`.

**Goods receipt** (`POST /purchasing/purchase-orders/receive`) now refuses a received date in the future and any line whose expiry is on or before the received date. Auto-created supplier invoice numbers include the branch code (`SINV-<BRANCH>-<seq>`) so each branch's first delivery no longer collides.

## Purchasing: packs, deliveries and prices

Quantities on the wire are always **units**; packs are a way of entering them. A purchase order line accepts `orderedPacks` (+ optional `unitsPerPack`) or `orderedQty`, and `packCost` or `unitCost`. Packs win when both are sent, and the pack used is stored on the line so a later product edit can't restate the order. Omitting the cost falls back to the supplier's price list, then to a **400** naming the product.

| Endpoint | Permission | Notes |
| --- | --- | --- |
| `GET /purchasing/purchase-orders` | `purchasing.view` | `unitCost`, `packCost` and `shippingCharges` are **null** without `purchasing.view_cost`. |
| `GET /purchasing/purchase-orders/:id` | `purchasing.view` | Lines add `orderedPacks`, `unitsPerPack`, `packCost`, `receivedQty`, `freeQty`, `rejectedQty`, `outstandingQty`, `outstandingPacks`. |
| `GET /purchasing/deliveries` | `purchasing.view` | Goods receipts for the branch, newest first. Query `supplierId`, `from`, `to`, `q`. Per-delivery `paidUnits`, `freeUnits`, `rejectedUnits`, and `value` (null without `purchasing.view_cost`). |
| `GET /purchasing/reorder-suggestions` | `purchasing.manage` | Products at or below their reorder level after subtracting **available** stock and everything already on order, grouped by the cheapest active supplier who lists them. `unassigned` holds those no supplier prices. |
| `POST /purchasing/purchase-orders/receive` | `purchasing.receive` | Lines accept `packs`/`receivedQty`, `freeQty`, `rejectedQty` (+ `rejectedReason`, required), `packCost`/`costPrice`, `sellingPrice`, `onCostConflict`. Body accepts `supplierDeliveryNote`, `acceptOverDelivery`, `acceptPriceVariance`, `updateSupplierPrice`. |
| `GET /purchasing/supplier-prices` | `purchasing.view_cost` | Compact price map (`productId`, `unitCost`, `unitsPerPack`, `discountPercent`) for prefilling order lines. |
| `GET /purchasing/batch-lookup` | `purchasing.receive` or `inventory.view` | `productId` + `batchNo` → whether that batch is already on the shelf here, with its expiry, units on hand and whether its expiry is still unconfirmed. Cost is withheld without `purchasing.view_cost`. |
| `GET /suppliers/:id/prices` | `suppliers.manage_prices` | The supplier's price list with `lastUnitCost` and `priceDrift` beside the agreed cost. |
| `PUT /suppliers/:id/prices` | `suppliers.manage_prices` | Upsert one product's price (`packCost` or `unitCost` required). |
| `DELETE /suppliers/:id/prices/:productId` | `suppliers.manage_prices` | Removes one product from the list. |

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

**Semantics**

- **Customer history spans branches; the prescription register does not.** Someone who fills a prescription at one shop and returns to another is the normal case, so `/:id/profile` is tenant-scoped. `Prescription.rxNumber` is unique per branch, so the register follows the `x-branch-id` header.
- Lifetime value counts **posted** sales only — a voided or refunded sale is not spend.
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

## Versioning

Pilot uses **`/api/v1`**. Breaking changes should move to `/api/v2` or be gated by explicit API version headers if you outgrow this model.
