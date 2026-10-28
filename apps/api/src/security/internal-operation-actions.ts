import type { ActionProfile } from "./operation-classification";

/** Reviewed non-HTTP entry points. This is a review inventory, not automatic call-graph
 * analysis or installed service enforcement. Services/workers must eventually consume
 * the same verified execution context as controllers, not reconstruct user headers.
 */
export const INTERNAL_OPERATION_ACTIONS = [
  { source: "sales/sales.service.ts", profile: "checkout", authority: "domain", note: "Checkout derives clinical effects from products; void/refund use refund profile." },
  { source: "sales/held-sales.service.ts", profile: "local_record", authority: "domain", note: "Hold, recall and discard remain bound to the local till/session." },
  { source: "sales/pharmacist-approval.service.ts", profile: "clinical", authority: "domain", note: "Qualified clinical evidence is independent of administrative permission." },
  { source: "inventory/adjustment.service.ts", profile: "mixed_stock", authority: "domain", note: "adjust preserves existing optional-approval policy; accept records exact approval only; post executes the approved write-off. reject is management." },
  { source: "inventory/inventory.service.ts", profile: "stock", authority: "domain", note: "Adjustment, expiry and quarantine/condition writes need local execution." },
  { source: "inventory/stock/stock.service.ts", profile: "stock", authority: "inherited", note: "Single writer. reserve/releaseReservations use reservation profile; receive/issue/quarantine/release/post/consumeReservations inherit physical execution authority." },
  { source: "transfers/transfers.service.ts", profile: "reservation", authority: "domain", note: "Create/approve/cancel may reserve/release remotely. Ship/receive use stock profile and each execution branch." },
  { source: "purchasing/purchasing.service.ts", profile: "stock", authority: "domain", note: "receiveGoods posts (direct, held or prepared delivery; approved exceptions only via exact evidence on the caller transaction); PO management methods use management profile." },
  { source: "purchasing/prepared-receipt.service.ts", profile: "mixed_stock", authority: "domain", note: "create/update/approve/cancel record a remote delivery and exact approval only; postInTransaction receives it through receiveGoods, pinned to the approval, rechecked after batch locks." },
  { source: "purchasing/held-delivery.service.ts", profile: "mixed_stock", authority: "domain", note: "prepare/accept record corrections and exact approval only; post receives the approved delivery. hold captures local quantities/condition; reject is management." },
  { source: "returns/returns.service.ts", profile: "stock", authority: "domain", note: "approve (and self-approved create/submit) records exact evidence only; completeInTransaction posts goods departure and the debit note, pinned to the latest approval; markLogistics is local confirmation; draft/reject are management." },
  { source: "stocktakes/stocktakes.service.ts", profile: "mixed_stock", authority: "domain", note: "approve persists exact evidence only; post applies stock/quarantine; legacy complete closes already-posted counts only. Counts/start/submit are local records; planning/review/recount are management." },
  { source: "product-import/product-import.service.ts", profile: "mixed_stock", authority: "worker", note: "Legacy not-live imports retain stock execution; live/fallback and explicit stage imports write only catalog/draft. Management undo refuses posted stock; legacy stock undo is separate physical execution. Signed command provenance remains executor integration work." },
  { source: "product-import/import-stock.service.ts", profile: "stock", authority: "domain", note: "Draft read/replace are management; post binds the saved stockVersion, creates batches and receives stock once per selected chunk, retaining original batch IDs and transactional actor audit. Physical terminal enforcement is the later P1/P2 coordinated cutover." },
  { source: "product-import/import-job-runner.ts", profile: "mixed_stock", authority: "worker", note: "start delegates work with persisted authority; heartbeat/sweepStale are job bookkeeping only." },
  { source: "product-import/product-import-jobs.ts", profile: "management", authority: "inherited", note: "In-memory progress bookkeeping conveys no stock authority." },
  { source: "purchasing/ledger/supplier-ledger.service.ts", profile: "supplier_payment", authority: "domain", note: "recordPayment/voidPayment derive method from authoritative state; invoices/debit notes are management; return credit inherits execution transaction." },
  { source: "suppliers/suppliers.service.ts", profile: "supplier_payment", authority: "domain", note: "Legacy payment path follows ledger policy; supplier master/price edits are management." },
  { source: "nmra/nmra-import.service.ts", profile: "management", authority: "domain", note: "Registry catalog import must preserve historical snapshot values; cannot acquire stock authority." },
  { source: "catalog-tasks/catalog-task.service.ts", profile: "management", authority: "domain", note: "Catalog refresh/apply bookkeeping, including GET-triggered refresh, does not confer physical execution authority." },
  { source: "inventory/stock/stock-projection.ts", profile: "stock", authority: "maintenance", note: "rebuildBatchStock is seed/maintenance only, never a remote business API escape hatch." },
] as const satisfies readonly {
  source: string;
  profile: ActionProfile;
  authority: "domain" | "inherited" | "worker" | "maintenance";
  note: string;
}[];
