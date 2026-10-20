# P0 operational mutation inventory

Baseline: develop `4a2fa3a`, 2026-10-19. Exact methods, paths and source files for all
166 unsafe HTTP routes are recorded in [POS_MUTATION_ROUTES.json](POS_MUTATION_ROUTES.json).
The inventory includes non-operational mutations to make exclusions explicit. P0 classifies
future enforcement; existing routes are not protected by the new terminal boundary yet.
Revised 2026-10-21: Shafeek approved remote online management/authorization with local
physical execution, superseding D10's blanket desktop-only restriction. Offline capability
creates no stock reservation. Runtime enforcement remains P1/P2/P6 work.

`node scripts/pos/check-mutation-inventory.mjs` detects route additions/removals in CI.
After reviewing any change, regenerate with `--write` and update this classification. The scanner
understands current literal Nest route decorators, including multiple controllers in one file;
it fails on unsupported decorator shapes. It is not a service-write analyzer. Service/background
changes still require the review below, including new mutations disguised behind GET endpoints.

## Required boundary by route family

Classify the complete server-side effects of each action, not whole route prefixes or HTTP
methods. Online remote management uses existing authenticated branch/role permissions.
Physical stock, branch cash, executed refunds and clinical dispensing require an enrolled
locally attended terminal with current staff/branch/clinical authority, including for owners.
Remote desktop sessions may manage/approve; they may not perform local physical execution.
D13 terminal designation also remains online/local/audited.

Mixed handlers that both approve and physically post must be split. Until split they inherit
local execution restrictions. Remote approval can create normal business reservations or
commercial commitments; it cannot automatically post on-hand stock, cash or an executed refund.
The approved offline sale/shift journal is a distinct exception, unchanged by revised D10.

| Exact route family (prefix under `/api/v1`) | Classification and consequence |
| --- | --- |
| `sales/checkout`, `sales/:id/void`, `sales/:id/refund` | Local checkout/executed void or refund. Add separate online remote return/refund preparation/authorization; keep original-sale limits. Offline sale uses its distinct signed journal protocol. |
| `sales/holds`, `sales/holds/:id`, `sales/holds/:id/recall` | Local POS cart writes/recall tied to till/session; current holds reserve no stock and are not a snapshot/journal. |
| `sales/pos/me/pos-pin`, `sales/pos/me/pos-pin/clear` | Staff credential administration; online authenticated self-service, not sale approval. No offline credential changes. |
| Future signed offline `shift_open` / `shift_close` commands | Approved D7b lifecycle exception on the nominated terminal's same till: local cash-count handover and new shift, prepared staff only. Not existing HTTP routes; sync them in the same durable command sequence as sales. No stock/outage/expiry reset; D9 adds no sale-count/value caps. |
| `inventory/*` | Online remote adjustment requests/review/approve/reject. Local actual counts/condition confirmation and stock posting, expiry confirmation, quarantine/release. Split held accept if it currently posts stock. |
| `transfers/*` | Online remote draft/review/approve/reject/cancel and ordinary reservation/release. Local source dispatch and destination receiving, each with its branch authority. No new offline reservations. |
| `stocktakes/*` | Online remote planning/scheduling/review/recount request/approval. Local physical count capture/confirmation and post/complete, including legacy completion. Preserve event timing to avoid double counting offline sales. |
| `returns/*` | Online remote supplier-return preparation/review/approval/rejection and commercial credit records. Local actual goods departure and stock posting. Customer return inspection/disposition and refund execution remain local sales workflows. |
| `purchasing/*` | Online remote PO drafts/edit/issue/review/approve/reject, invoices/debit notes and bank-payment records with evidence. Local receipt/batch/quantity/condition confirmation, held-delivery stock acceptance and branch cash payout. Split mixed approve/post handlers. |
| `suppliers/*` | Online remote supplier/master/price management. Legacy invoice payments use the same evidence/authority rules: bank-payment record remote, actual branch cash local. |
| `products/*` | Online remote catalog/prices/eligibility/categories/tags/aliases/NMRA/barcode and catalog-only import/analyze/preview/selection. Import confirm/undo creating/removing batches or stock requires local execution; split mixed jobs. Preserve historical snapshot identities. |
| `catalog-tasks/*` | Online remote catalog refresh/apply/dismiss/reopen, including bulk safe apply, with permissions and provenance. A stock-bearing side effect requires local execution. |
| `customers/*`, `prescriptions` | Online remote administrative customer contact editing with existing permissions/privacy. Prescription clinical verification, qualified sign-off and dispensing remain local and online; administrative permission is not clinical authority. |
| `admin/*`, `staff-invitations/*` | Online identity/access administration; remote management allowed with existing permissions. Changes invalidate sessions/grants according to revocation policy; cannot retroactively undo disconnected sales. |
| `auth/*` | Authentication/self-profile/password/avatar/session management, allowed online from permitted clients; never confers terminal authority by itself. |
| `tenant/*` | Online remote tenant/branch/settings management. Settings version future grants, never rewrite signed historical grants or rebind enrolled identity. D13 designation is still local/online/audited. |
| `onboarding/*`, `setup/readiness/*` | Online setup/configuration; existing permission checks retained. Must not add stock/dispensing operations under this exemption. |
| `analytics/branch-monthly-targets`, `dashboard/layout` | Non-operational planning/personalization; remote writes allowed with existing permissions. |
| `notifications/*` | Non-operational user state/preferences; remote writes allowed. Acting on an alert still invokes an operational endpoint. |
| `uploads/image` | Attachment storage only; remote allowed with current restrictions. Linking an upload to an operational record still requires its protected route. |

Approval evidence must bind exact tenant/branch/document version/content and action.
Material changes require fresh approval. Keep requester, approver and executor separately,
preserve existing self-approval policy, and allow an authorized on-site approver to execute
where permitted. Resolve and revalidate evidence transactionally, with domain quantity/refund
limits and idempotency. See [the normative D10 matrix](POS_V1_CONTRACT.md#revised-d10-remote-management-local-physical-execution).

## Internal writers, workers and alternate entry points

| Source | Required follow-up |
| --- | --- |
| `sales/sales.service.ts`, `sales/held-sales.service.ts`, `sales/pharmacist-approval.service.ts` | Bind actor, enrollment/session, command and approval evidence throughout checkout, cart recall, void and refund. Same authority in service calls, not just controllers. |
| `inventory/stock/stock.service.ts` | Single ordinary stock writer; retain sorted batch locks and current availability checks. Snapshot generation/refresh must not reserve stock. Proposed sync posts through this service or persists an explicit stock discrepancy, never bypasses checks to hide a shortage. Existing `scripts/check-stock-writes.mjs` remains required. |
| `transfers/transfers.service.ts` | `reserve`, `releaseReservations`, `consumeReservations`, ship and receive keep their existing business reservations. Preserve source/audit history for snapshot reconciliation. |
| `inventory/inventory.service.ts`, `returns/returns.service.ts`, `purchasing/purchasing.service.ts` | Adjustments, quarantine, goods receipts/free goods, returns and holds respect normal availability. Snapshot-era differences become reconciliation evidence. Audit requester, approver and executor separately; remote authorization cannot implicitly execute physical effects. |
| `stocktakes/stocktakes.service.ts`, `inventory/stock/stock-balance.ts` | `allowReservedShortfall` still concerns existing business reservations. A count taken during disconnection must be compared with offline sales and their times to avoid counting the same physical change twice. |
| `product-import/product-import.service.ts` | Import creates products, batches and stock via StockService; catalog-only stages permit remote management; stock-bearing confirm and undo require local execution authority. Undo directly deletes stock-ledger rows and eligible batches/products. Outstanding journal/snapshot references require retained identities/tombstones or explicit review so later offline sales remain interpretable. |
| `product-import/import-job-runner.ts`, `product-import/product-import-jobs.ts` | Async work outlives HTTP request. Persist initiating staff/branch/command and approval provenance, plus device/session for stock-bearing execution. Revalidate complete effect authority before commits; remote catalog jobs cannot acquire stock-posting authority. Record job/command linkage. Startup/interval stale-job sweeps and heartbeats update job status only; must never repost stock or discard offline journals. No Bull/Redis queue is currently used here. |
| `nmra/*`, `products/*`, `catalog-tasks/*` services | Registry/barcode merges, bulk catalog changes and automated task actions cannot rewrite signed historical snapshot eligibility/pricing or mutate stock without authorized context. Current online catalog may change normally; sync must preserve historical evidence. |
| `purchasing/ledger/*`, `suppliers/*` services | Trace both payment paths and debit-note/invoice mutations. Evidence-backed bank-payment recording may be remote; actual drawer cash requires local execution. Internal calls inherit these rules. |
| `inventory/stock/stock-projection.ts`, Prisma seeds and migrations | Projection repair, reservation backfill and seed synchronization are maintenance-only. Require explicit maintenance context; preserve offline journals, receipts, snapshot references and open discrepancy cases during repair. |
| `apps/api/scripts/*`, repository maintenance scripts | Reconciliation tooling is read-only unless explicitly a migration/seed. New direct writes must be inventoried and reviewed as maintenance operations. |
| `apps/mobile/App.tsx` | Current mobile app is a display shell, with no operational calls. Bearer-auth API access is still a possible alternate path: P1 must allow authorized online management and deny physical execution without verified local context, regardless of claimed client headers. |
| `apps/web` API proxy/callers | Existing browser operational UI uses the same API routes. P1/P6 retain remote management/catalog editing and approvals, add version/status/actor feedback, and hand physical execution to the local desktop. API checks remain authoritative; split mixed handlers before exposing remote approvals. |
| `apps/pos-desktop/src/shared/ipc-contract.ts` | Current bridge exposes readiness/API probe/printer/test receipt, no checkout. Future IPC commands validate strict inputs; signing/authority remain in main, not preload/renderer. |

Search performed: all controllers and `setInterval`, `setTimeout`, `Cron`, `Processor` uses
under API source, plus StockService call sites and mobile shell. The import runner is the
current scheduled/background write path found. This is a baseline audit, not a promise that
future workers or GET side effects are automatically covered by the route scanner.
