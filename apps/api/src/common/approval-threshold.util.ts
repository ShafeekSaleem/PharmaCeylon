import { Prisma } from "@prisma/client";

/**
 * Tenant-configured approval thresholds (Settings → Approval Rules).
 *
 * These settings existed and persisted for a long time before anything read
 * them: whether a purchase order needed approval was decided by a
 * `submitForApproval` flag the *client* sent, which meant the configured
 * ceiling was advisory and a caller could simply omit the flag. The helpers
 * here are the single place that turns a stored threshold into a decision, so
 * purchasing, returns and transfers cannot drift apart again.
 *
 * The rule is deliberately role-blind. Approval authority is already a distinct
 * permission (`purchasing.approve`, `returns.approve`, `transfers.approve`), so
 * a document held for approval is only clearable by someone who holds it — no
 * second role carve-out is needed here, and adding one would reintroduce a way
 * for a high-value document to skip the queue.
 */

/** `null` / `undefined` means "no threshold configured" — approval is never forced. */
export function meetsApprovalThreshold(
  value: Prisma.Decimal,
  threshold: Prisma.Decimal | null | undefined,
): boolean {
  if (threshold === null || threshold === undefined) return false;
  // A threshold of 0 is a legitimate "approve everything" setting, not "off" —
  // `null` is how the UI records off.
  return value.greaterThanOrEqualTo(threshold);
}

export type MoneyLine = {
  qty: number;
  unitAmount: Prisma.Decimal | string | number;
  discountPercent?: number | null;
  taxPercent?: number | null;
};

/**
 * Committed value of a set of lines: `(qty × unit − discount) + tax`.
 *
 * Matches `poTotals`/`lineMoneyParts` in the web app exactly — tax applies to
 * the post-discount net — so the figure compared against the threshold is the
 * same grand total the person saw before they pressed Save. A threshold that
 * fired on a different number than the UI displayed would read as a bug.
 */
export function linesValue(
  lines: MoneyLine[],
  shippingCharges: Prisma.Decimal | string | number = 0,
): Prisma.Decimal {
  const total = lines.reduce((sum, line) => {
    const base = new Prisma.Decimal(line.unitAmount).mul(line.qty);
    const discount = base.mul(new Prisma.Decimal(line.discountPercent ?? 0)).div(100);
    const net = base.sub(discount);
    const tax = net.mul(new Prisma.Decimal(line.taxPercent ?? 0)).div(100);
    return sum.add(net).add(tax);
  }, new Prisma.Decimal(0));
  return total.add(new Prisma.Decimal(shippingCharges || 0));
}
