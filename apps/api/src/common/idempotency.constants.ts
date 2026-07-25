/** Scopes for `IdempotencyRecord` — keep stable for clients. */
export const IDEMPOTENCY_SCOPE = {
  checkout: "checkout",
  receiveGoods: "receive_goods",
  transferShip: "transfer_ship",
  transferReceive: "transfer_receive",
  returnComplete: "return_complete",
} as const;

export type IdempotencyScope = (typeof IDEMPOTENCY_SCOPE)[keyof typeof IDEMPOTENCY_SCOPE];
