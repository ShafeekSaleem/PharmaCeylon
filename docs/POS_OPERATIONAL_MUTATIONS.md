# P0 operational mutation inventory

Baseline: develop `4a2fa3a`, 2026-10-19. Exact methods, paths and source files for all
166 unsafe HTTP routes are recorded in [POS_MUTATION_ROUTES.json](POS_MUTATION_ROUTES.json).
The inventory includes non-operational mutations to make exclusions explicit. P0 classifies
future enforcement; existing routes are not protected by the new terminal boundary yet.
Updated 2026-10-20 for the approved snapshot approach: offline capability creates no central
stock reservation. Shafeek approved the broad local-desktop operational boundary in D10 on
2026-10-20, including the listed sales/stock/catalog/patient/procurement edits and owner restriction.
The rows below map that boundary to implementation entry points; runtime enforcement remains P1/P2/P6 work.

`node scripts/pos/check-mutation-inventory.mjs` detects route additions/removals in CI.
After reviewing any change, regenerate with `--write` and update this classification. The scanner
understands current literal Nest route decorators, including multiple controllers in one file;
it fails on unsupported decorator shapes. It is not a service-write analyzer. Service/background
changes still require the review below, including new mutations disguised behind GET endpoints.

## Required boundary by route family

Every method in the JSON inventory matches one family below. All operational families require
an enrolled, locally attended desktop, current staff authority, branch binding and audit; online
checks are mandatory except for the new ordinary-sale and approved D7b shift-handover journal protocol. Browser/mobile/remote
sessions cannot bypass this with owner permissions or by calling an older route directly.

| Exact route family (prefix under `/api/v1`) | Classification and consequence |
| --- | --- |
| `sales/checkout`, `sales/:id/void`, `sales/:id/refund` | Operational. Existing checkout stays online; offline sale is a distinct signed journal command. All void/refunds online. |
| `sales/holds`, `sales/holds/:id`, `sales/holds/:id/recall` | Operational cart writes, including destructive recall. Holds currently reserve no stock and are not an offline snapshot/journal. |
| `sales/pos/me/pos-pin`, `sales/pos/me/pos-pin/clear` | Staff credential administration; online authenticated self-service, not sale approval. No offline credential changes. |
| Future signed offline `shift_open` / `shift_close` commands | Approved D7b lifecycle exception on the nominated terminal's same till: local cash-count handover and new shift, prepared staff only. Not existing HTTP routes; sync them in the same durable command sequence as sales. No stock/outage/expiry reset; D9 adds no sale-count/value caps. |
| `inventory/*` | Operational: adjustments, held accept/reject, expiry confirmation, quarantine/release and bulk expired quarantine. All online; audit changes that may conflict with disconnected snapshots. |
| `transfers/*` | Operational: create/approve/reject/cancel/ship/receive. Existing approval reserves, cancellation releases, shipment consumes reservations. No new offline reservation type. Later offline sales may conflict with a transfer made after snapshot capture. |
| `stocktakes/*` | Operational: draft/line edits, add/remove, schedule/start/submit, review/recount, approve/post/complete/cancel. All online, including legacy completion paths. Counts may race with disconnected sales; reconcile against the event history rather than deleting later offline sales. |
| `returns/*` | Operational: create/edit/submit/approve/reject/logistics/complete/cancel. Supplier stock issue and credit effects require online checks; customer return remains sales refund workflow. |
| `purchasing/*` | Operational: PO lifecycle, held deliveries, receipt, invoice create/void, payment create/void, debit-note apply/void. Include draft/approval routes, not just final posting. |
| `suppliers/*` | Operational procurement master/price edits and legacy `invoices/:id/payments`. Online only; legacy payment path must use the same ledger authority. |
| `products/*` | Operational catalog/price/eligibility edits, bulk, range, categories/tags/aliases, NMRA links, imports/confirm/undo and barcode imports. Online local desktop. Preview/analyze/selection endpoints may be exposed remotely only after P1 proves they have no persistent operational side effects and explicitly allowlists them. Default is terminal required. |
| `catalog-tasks/*` | Operational catalog workflows: refresh, apply-safe, apply, dismiss, not-applicable, reopen. Include bulk safe-apply paths; no unattended shortcut around authority. |
| `customers/*`, `prescriptions` | Operational patient/customer and prescription writes; online local desktop with existing permissions. Reads remain permission-gated. |
| `admin/*`, `staff-invitations/*` | Online identity/access administration; remote management allowed with existing permissions. Changes invalidate sessions/grants according to revocation policy; cannot retroactively undo disconnected sales. |
| `auth/*` | Authentication/self-profile/password/avatar/session management, allowed online from permitted clients; never confers terminal authority by itself. |
| `tenant/*` | Online tenant/branch/configuration administration; remote management allowed. Settings are versioned inputs for future grants, not retroactive edits to signed grants. Branch edits cannot rebind existing terminal identity. No transaction approval endpoints are included in this exception. |
| `onboarding/*`, `setup/readiness/*` | Online setup/configuration; existing permission checks retained. Must not add stock/dispensing operations under this exemption. |
| `analytics/branch-monthly-targets`, `dashboard/layout` | Non-operational planning/personalization; remote writes allowed with existing permissions. |
| `notifications/*` | Non-operational user state/preferences; remote writes allowed. Acting on an alert still invokes an operational endpoint. |
| `uploads/image` | Attachment storage only; remote allowed with current restrictions. Linking an upload to an operational record still requires its protected route. |

The operational contract's deliberate broad catalog/customer/procurement classification prevents
browser or mobile changes from altering eligibility, money or stock indirectly. Narrow exceptions
require explicit P0 review, not a blanket exemption for non-stock-looking endpoints.

## Internal writers, workers and alternate entry points

| Source | Required follow-up |
| --- | --- |
| `sales/sales.service.ts`, `sales/held-sales.service.ts`, `sales/pharmacist-approval.service.ts` | Bind actor, enrollment/session, command and approval evidence throughout checkout, cart recall, void and refund. Same authority in service calls, not just controllers. |
| `inventory/stock/stock.service.ts` | Single ordinary stock writer; retain sorted batch locks and current availability checks. Snapshot generation/refresh must not reserve stock. Proposed sync posts through this service or persists an explicit stock discrepancy, never bypasses checks to hide a shortage. Existing `scripts/check-stock-writes.mjs` remains required. |
| `transfers/transfers.service.ts` | `reserve`, `releaseReservations`, `consumeReservations`, ship and receive keep their existing business reservations. Preserve source/audit history for snapshot reconciliation. |
| `inventory/inventory.service.ts`, `returns/returns.service.ts`, `purchasing/purchasing.service.ts` | Adjustments, quarantine, goods receipts/free goods, returns and holds respect normal availability. Snapshot-era differences become reconciliation evidence. Audit both request and eventual approval actor. |
| `stocktakes/stocktakes.service.ts`, `inventory/stock/stock-balance.ts` | `allowReservedShortfall` still concerns existing business reservations. A count taken during disconnection must be compared with offline sales and their times to avoid counting the same physical change twice. |
| `product-import/product-import.service.ts` | Import creates products, batches and stock via StockService; confirm and undo must carry operational authority. Undo directly deletes stock-ledger rows and eligible batches/products. Outstanding journal/snapshot references require retained identities/tombstones or explicit review so later offline sales remain interpretable. |
| `product-import/import-job-runner.ts`, `product-import/product-import-jobs.ts` | Async work outlives HTTP request. Persist initiating device/staff/branch/command authority, revalidate before operational commits, record job/command linkage. Startup/interval stale-job sweeps and heartbeats update job status only; must never repost stock or discard offline journals. No Bull/Redis queue is currently used here. |
| `nmra/*`, `products/*`, `catalog-tasks/*` services | Registry/barcode merges, bulk catalog changes and automated task actions cannot rewrite signed historical snapshot eligibility/pricing or mutate stock without authorized context. Current online catalog may change normally; sync must preserve historical evidence. |
| `purchasing/ledger/*`, `suppliers/*` services | Trace both payment entry points and debit-note/invoice mutations; server-internal calls do not exempt financial authority. |
| `inventory/stock/stock-projection.ts`, Prisma seeds and migrations | Projection repair, reservation backfill and seed synchronization are maintenance-only. Require explicit maintenance context; preserve offline journals, receipts, snapshot references and open discrepancy cases during repair. |
| `apps/api/scripts/*`, repository maintenance scripts | Reconciliation tooling is read-only unless explicitly a migration/seed. New direct writes must be inventoried and reviewed as maintenance operations. |
| `apps/mobile/App.tsx` | Current mobile app is a display shell, with no operational calls. Bearer-auth API access is still a possible alternate path: P1 must deny operational mutations regardless of client headers. |
| `apps/web` API proxy/callers | Existing browser operational UI uses the same API routes. P1/P6 must disable/replace those actions with desktop handoff and clear errors; hiding buttons alone is insufficient. |
| `apps/pos-desktop/src/shared/ipc-contract.ts` | Current bridge exposes readiness/API probe/printer/test receipt, no checkout. Future IPC commands validate strict inputs; signing/authority remain in main, not preload/renderer. |

Search performed: all controllers and `setInterval`, `setTimeout`, `Cron`, `Processor` uses
under API source, plus StockService call sites and mobile shell. The import runner is the
current scheduled/background write path found. This is a baseline audit, not a promise that
future workers or GET side effects are automatically covered by the route scanner.
