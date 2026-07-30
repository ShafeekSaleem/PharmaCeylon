"use client";

import { useMemo } from "react";
import type { PosAlert, Prescription, ResolvedCartLine } from "../types";

/**
 * Compliance and stock warnings for the cart. A blocking alert stops checkout —
 * everything else is advisory so the counter keeps moving.
 */
export function usePosAlerts(
  lines: ResolvedCartLine[],
  prescription: Prescription | null,
): { alerts: PosAlert[]; blockingAlerts: PosAlert[] } {
  return useMemo(() => {
    const alerts: PosAlert[] = [];

    const controlled = lines.filter((l) => l.product.isControlled);
    if (controlled.length > 0 && !prescription) {
      alerts.push({
        id: "controlled-no-rx",
        severity: "danger",
        title: "Controlled medicine requires prescription",
        detail: controlled.map((l) => l.product.name).join(", "),
        count: controlled.length,
        blocking: true,
      });
    } else if (controlled.length > 0 && prescription) {
      alerts.push({
        id: "controlled-linked",
        severity: "info",
        title: `Dispensing against ${prescription.rxNumber}`,
        detail: controlled.map((l) => l.product.name).join(", "),
        count: controlled.length,
      });
    }

    const overStock = lines.filter((l) => l.overStock);
    if (overStock.length > 0) {
      alerts.push({
        id: "over-stock",
        severity: "danger",
        title: "Quantity exceeds available stock",
        detail: overStock
          .map((l) => `${l.product.name} — ${l.batch.qtyOnHand} left`)
          .join(", "),
        count: overStock.length,
        blocking: true,
      });
    }

    const lowStock = lines.filter(
      (l) => !l.overStock && l.product.stockStatus !== "ok" && l.product.qtyOnHand > 0,
    );
    if (lowStock.length > 0) {
      alerts.push({
        id: "low-stock",
        severity: "warning",
        title: "Low stock: item in cart",
        detail: lowStock
          .map((l) => `${l.product.name} (${l.product.qtyOnHand} on hand)`)
          .join(", "),
        count: lowStock.length,
      });
    }

    const nearExpiry = lines.filter((l) => l.batch.nearExpiry);
    if (nearExpiry.length > 0) {
      alerts.push({
        id: "near-expiry",
        severity: "warning",
        title: "Near expiry batch in cart",
        detail: nearExpiry
          .map(
            (l) =>
              `${l.product.name} · batch ${l.batch.batchNo} (${Math.max(l.batch.daysToExpiry, 0)} days left)`,
          )
          .join(", "),
        count: nearExpiry.length,
      });
    }

    if (prescription?.validUntil) {
      const validUntil = new Date(prescription.validUntil);
      if (!Number.isNaN(validUntil.getTime()) && validUntil.getTime() < Date.now()) {
        alerts.push({
          id: "rx-expired",
          severity: "danger",
          title: "Linked prescription has expired",
          detail: `${prescription.rxNumber} expired on ${validUntil.toLocaleDateString()}`,
          count: 1,
          blocking: true,
        });
      }
    }

    return { alerts, blockingAlerts: alerts.filter((a) => a.blocking) };
  }, [lines, prescription]);
}
