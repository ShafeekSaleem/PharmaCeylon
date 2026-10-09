import { PaymentMethod, Prisma } from "@prisma/client";

type Payment = { method: PaymentMethod; amount: Prisma.Decimal };

/** Cash goes back last: a card or wallet refund lands where it came from without the drawer. */
const ORDER: PaymentMethod[] = [
  PaymentMethod.card,
  PaymentMethod.mobile_wallet,
  PaymentMethod.credit,
  PaymentMethod.cash,
];

/**
 * Split a refund across the ways the sale was paid ("as paid").
 *
 * What each method can still give back is what it took, less refunds already made to it. Cash
 * took what was tendered less the change handed back (change is only ever given in cash). The
 * refund is placed on card, wallet and credit first and cash last; anything left over — a refund
 * larger than what the methods can account for, which a correct sale never produces — goes to
 * cash so the refund always balances.
 */
export function allocateRefund(
  payments: readonly Payment[],
  changeDue: Prisma.Decimal,
  refundTotal: Prisma.Decimal,
): Array<{ method: PaymentMethod; amount: Prisma.Decimal }> {
  const left = new Map<PaymentMethod, Prisma.Decimal>();
  for (const payment of payments) {
    left.set(payment.method, (left.get(payment.method) ?? new Prisma.Decimal(0)).add(payment.amount));
  }
  if (left.has(PaymentMethod.cash)) {
    left.set(PaymentMethod.cash, left.get(PaymentMethod.cash)!.sub(changeDue));
  }

  const out: Array<{ method: PaymentMethod; amount: Prisma.Decimal }> = [];
  let remaining = refundTotal;
  for (const method of ORDER) {
    if (remaining.lte(0)) break;
    const available = left.get(method);
    if (!available || available.lte(0)) continue;
    const take = Prisma.Decimal.min(available, remaining);
    out.push({ method, amount: take });
    remaining = remaining.sub(take);
  }
  if (remaining.gt(0)) {
    const cash = out.find((row) => row.method === PaymentMethod.cash);
    if (cash) cash.amount = cash.amount.add(remaining);
    else out.push({ method: PaymentMethod.cash, amount: remaining });
  }
  return out;
}
