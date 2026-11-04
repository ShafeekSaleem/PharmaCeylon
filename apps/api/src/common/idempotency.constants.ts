/** Scopes for `IdempotencyRecord` — keep stable for clients. */
export const IDEMPOTENCY_SCOPE = {
  checkout: "checkout",
  receiveGoods: "receive_goods",
  transferShip: "transfer_ship",
  transferReceive: "transfer_receive",
  returnComplete: "return_complete",
  saleRefundExecute: "sale_refund_execute",
  supplierPayment: "supplier_payment",
  supplierEvidencedPayment: "supplier_evidenced_payment",
  productImport: "product_import",
  heldAdjustmentRequest: "held_adjustment_request",
  stockAdjustment: "stock_adjustment",
} as const;

export type IdempotencyScope =
  (typeof IDEMPOTENCY_SCOPE)[keyof typeof IDEMPOTENCY_SCOPE];
