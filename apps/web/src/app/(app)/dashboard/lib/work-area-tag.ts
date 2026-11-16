import type { DailyWorkKind } from "@pharmaceylon/shared";

/** Neutral area tag on Today’s priorities rows — mapped from work kind (v6). */
const KIND_AREA_TAG: Partial<Record<DailyWorkKind, string>> = {
  "purchase_order.approve": "Purchasing",
  "purchase_order.draft": "Purchasing",
  "purchase_order.receive": "Purchasing",
  "held_delivery.approve": "Payments",
  "held_delivery.post": "Payments",
  "prepared_receipt.approve": "Payments",
  "prepared_receipt.post": "Payments",
  "supplier_cash_payout.approve": "Payments",
  "supplier_cash_payout.execute": "Payments",
  "transfer.approve": "Transfer approval",
  "transfer.ship": "Transfer approval",
  "transfer.receive": "Transfer approval",
  "goods_return.approve": "Supplier returns",
  "goods_return.draft": "Supplier returns",
  "goods_return.complete": "Supplier returns",
  "batch.expiry_review": "Expiry",
  "sale_refund.approve": "Refunds",
  "sale_refund.execute": "Refunds",
  "stocktake.approve": "Stocktake",
  "stocktake.post": "Stocktake",
  "stocktake.complete": "Stocktake",
  "stocktake.prepare": "Stocktake",
  "stocktake.count": "Stocktake",
  "held_sale.resume": "Counter",
  "held_sale.pharmacist_review": "Counter",
  "held_adjustment.approve": "Inventory",
  "held_adjustment.post": "Inventory",
  "import_stock.post": "Inventory",
  "offline_stock_case.review": "Inventory",
  "offline_stock_case.resolve": "Inventory",
  "offline_journal.review": "Inventory",
};

export function workAreaTag(kind: DailyWorkKind): string {
  if (KIND_AREA_TAG[kind]) return KIND_AREA_TAG[kind]!;
  const prefix = kind.split(".")[0] ?? kind;
  if (prefix === "purchase_order") return "Purchasing";
  if (prefix === "transfer") return "Transfer approval";
  if (prefix === "goods_return") return "Supplier returns";
  if (prefix === "stocktake") return "Stocktake";
  if (prefix === "sale_refund") return "Refunds";
  return "Operations";
}