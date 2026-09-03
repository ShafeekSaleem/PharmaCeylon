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

## Idempotency (money / stock mutations)

Send optional header **`Idempotency-Key`** (max 128 characters, trimmed). Keys are scoped per **`tenantId` + `userId` + operation scope** so two users do not collide.

| Operation        | Scope (internal)   | HTTP                                              |
| ---------------- | ------------------ | ------------------------------------------------- |
| POS checkout     | `checkout`         | `POST /api/v1/sales/checkout`                     |
| Goods receipt    | `receive_goods`    | `POST /api/v1/purchasing/purchase-orders/receive` |
| Transfer ship    | `transfer_ship`    | `POST /api/v1/transfers/:id/ship`                 |
| Transfer receive | `transfer_receive` | `POST /api/v1/transfers/:id/receive`              |
| Product import   | `product_import`   | `POST /api/v1/products/import/confirm`            |

**Semantics**

- First request with a key performs the mutation and records the key → resource id.
- Retries with the **same** key return the **same** resource (replay).
- Reusing a key for a **different** logical operation (e.g. different PO on receive, different transfer id on ship/receive) returns **400** with a clear message—do not silently post twice.

## Sales lifecycle (pilot)

- **Checkout**: `POST /api/v1/sales/checkout` — optional `Idempotency-Key`. Line **tax**: send `taxAmount` per line, or omit to apply **VAT** from server config (see below).
- **Void** (posted → voided, stock restored; elevated roles): `POST /api/v1/sales/:id/void`
- **Refund** (posted → refunded, stock restored): `POST /api/v1/sales/:id/refund`

**Controlled products** (`Product.isControlled`): checkout requires **pharmacist**, **manager**, or **owner** effective on the branch (owners may be recognized tenant-wide per service rules).

## Pricing / tax (Sri Lanka–oriented, configurable)

- **`PRICING_VAT_RATE_PERCENT`**: default `0`. When a checkout line omits `taxAmount`, VAT is computed as **exclusive** on `(unitPrice × qty − discountAmount)`, rounded half-up to 2 decimal places.
- Set to the statutory rate for your deployment when you want server-driven VAT without the client sending line tax.

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

## Versioning

Pilot uses **`/api/v1`**. Breaking changes should move to `/api/v2` or be gated by explicit API version headers if you outgrow this model.
