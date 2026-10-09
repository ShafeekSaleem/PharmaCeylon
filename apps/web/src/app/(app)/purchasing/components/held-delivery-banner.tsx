"use client";

import { ModalButton } from "@/components/ui";
import type { HeldDelivery, PurchaseOrderDetail } from "../types";
import { formatDateTime, formatMoney } from "../utils";
import css from "../purchasing.module.css";

const REASON_LABELS: Record<HeldDelivery["reasons"][number], string> = {
  over_delivery: "more arrived than was ordered",
  price_variance: "billed above the agreed price",
};

/** Good units a held line brings in, however it was counted at the door. */
export function heldLineUnits(line: HeldDelivery["delivery"]["lines"][number]): number {
  if (line.receivedQty != null) return line.receivedQty;
  return (line.packs ?? 0) * Math.max(line.unitsPerPack ?? 1, 1);
}

type Props = {
  held: HeldDelivery;
  order: PurchaseOrderDetail;
  canDecide: boolean;
  busy: boolean;
  onReview: () => void;
  onReject: () => void;
};

/**
 * A delivery waiting for an approver, shown on its order: what arrived and was billed beside
 * what the order still has outstanding and agreed to pay, so the decision is made on the facts
 * the receiver had in front of them.
 */
export function HeldDeliveryBanner({ held, order, canDecide, busy, onReview, onReject }: Props) {
  const itemByProduct = new Map(order.items.map((item) => [item.productId, item]));
  const who = held.requester.fullName || "A colleague";
  const why = held.reasons.map((reason) => REASON_LABELS[reason]).join(" · ");

  return (
    <section className={css.heldBanner} aria-labelledby={`held-${held.id}`}>
      <div className={css.heldBannerHead}>
        <div>
          <h3 id={`held-${held.id}`} className={css.heldBannerTitle}>
            A delivery is waiting for approval
          </h3>
          <p className={css.heldBannerMeta}>
            {who} · {formatDateTime(held.requestedAt)} · {why}
          </p>
        </div>
        {canDecide ? (
          <div className={css.heldBannerActions}>
            <ModalButton variant="danger" onClick={onReject} disabled={busy}>
              Reject
            </ModalButton>
            <ModalButton variant="primary" onClick={onReview} disabled={busy}>
              Review delivery
            </ModalButton>
          </div>
        ) : null}
      </div>
      <div className={css.heldTableScroll}>
        <table className={css.heldTable}>
          <thead>
            <tr>
              <th>Product</th>
              <th className={css.heldNum}>Outstanding</th>
              <th className={css.heldNum}>Arrived</th>
              <th className={css.heldNum}>Agreed cost</th>
              <th className={css.heldNum}>Billed cost</th>
            </tr>
          </thead>
          <tbody>
            {held.delivery.lines.map((line) => {
              const item = itemByProduct.get(line.productId);
              const units = heldLineUnits(line);
              const outstanding = item?.outstandingQty ?? 0;
              const agreed = item?.unitCost != null ? Number(item.unitCost) : null;
              const billed = line.costPrice != null ? Number(line.costPrice) : null;
              const over = units > outstanding;
              const dearer = agreed != null && billed != null && billed > agreed;
              return (
                <tr key={line.productId}>
                  <td>
                    {item ? `${item.product.sku} — ${item.product.name}` : "Product"}
                    <span className={css.heldLineMeta}>
                      Batch {line.batchNo}
                      {line.freeQty ? ` · ${line.freeQty} free` : ""}
                      {line.rejectedQty ? ` · ${line.rejectedQty} damaged` : ""}
                    </span>
                  </td>
                  <td className={css.heldNum}>{outstanding}</td>
                  <td className={`${css.heldNum}${over ? ` ${css.heldFlag}` : ""}`}>{units}</td>
                  <td className={css.heldNum}>{agreed == null ? "—" : formatMoney(agreed)}</td>
                  <td className={`${css.heldNum}${dearer ? ` ${css.heldFlag}` : ""}`}>
                    {billed == null ? "—" : formatMoney(billed)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!canDecide ? (
        <p className={css.heldBannerMeta}>
          Nothing is booked in until someone who approves orders accepts it.
        </p>
      ) : null}
    </section>
  );
}
