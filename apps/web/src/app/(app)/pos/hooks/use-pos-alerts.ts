"use client";

import { useMemo } from "react";
import type {
  Customer,
  PosAlert,
  PosMode,
  Prescription,
  ResolvedCartLine,
} from "../types";
import { nameSimilarity } from "../utils";

type Options = {
  lines: ResolvedCartLine[];
  prescription: Prescription | null;
  customer: Customer | null;
  mode?: PosMode;
  /** Current user can dispense controlled items without PIN co-sign. */
  canDispenseControlled: boolean;
};

/**
 * Compliance and stock warnings for the cart.
 * Blocking alerts stop checkout. Pharmacist PIN is a handoff gate (not a dead end):
 * Complete Sale opens the PIN modal instead of staying disabled forever.
 */
export function usePosAlerts({
  lines,
  prescription,
  customer,
  mode = "retail",
  canDispenseControlled,
}: Options): {
  alerts: PosAlert[];
  blockingAlerts: PosAlert[];
  needsPharmacistPin: boolean;
  softRxWarnings: string[];
} {
  return useMemo(() => {
    const alerts: PosAlert[] = [];
    const softRxWarnings: string[] = [];

    const needsRx = lines.filter(
      (l) => l.product.requiresPrescription || l.product.isControlled,
    );
    const controlled = lines.filter((l) => l.product.isControlled);

    if (needsRx.length > 0 && !prescription) {
      alerts.push({
        id: "rx-required",
        severity: "danger",
        title: "Prescription required",
        detail: needsRx.map((l) => l.product.name).join(", "),
        count: needsRx.length,
        blocking: true,
        actions: [
          { kind: "link_rx", label: "Link Rx" },
          { kind: "hold_pharmacist", label: "Hold for pharmacist" },
        ],
      });
    } else if (controlled.length > 0 && prescription) {
      if (canDispenseControlled) {
        alerts.push({
          id: "controlled-linked",
          severity: "info",
          title: `Dispensing against ${prescription.rxNumber}`,
          detail: controlled.map((l) => l.product.name).join(", "),
          count: controlled.length,
        });
      } else {
        alerts.push({
          id: "needs-pharmacist-pin",
          severity: "warning",
          title: "Pharmacist approval needed",
          detail:
            "Controlled items are ready — ask a pharmacist for till PIN, or park for handoff. You can keep taking tender.",
          count: controlled.length,
          actions: [
            { kind: "pharmacist_pin", label: "Enter PIN" },
            { kind: "hold_pharmacist", label: "Hold for pharmacist" },
          ],
        });
      }
    } else if (needsRx.length > 0 && prescription && controlled.length === 0) {
      alerts.push({
        id: "rx-linked",
        severity: "info",
        title: `Dispensing against ${prescription.rxNumber}`,
        detail: needsRx.map((l) => l.product.name).join(", "),
        count: needsRx.length,
      });
    }

    const needsPharmacistPin =
      controlled.length > 0 && Boolean(prescription) && !canDispenseControlled;

    if (mode === "prescription" && lines.length > 0 && !prescription) {
      alerts.push({
        id: "prescription-mode-no-rx",
        severity: "danger",
        title: "Prescription mode requires a linked Rx",
        detail: "Link a prescription before completing this sale.",
        count: 1,
        blocking: true,
        actions: [{ kind: "link_rx", label: "Link Rx" }],
      });
    }

    if (prescription && customer?.fullName) {
      const score = nameSimilarity(customer.fullName, prescription.patientName);
      if (score < 0.34) {
        const msg = `Patient on Rx (“${prescription.patientName}”) does not closely match customer (“${customer.fullName}”). Confirm identity.`;
        softRxWarnings.push(msg);
        alerts.push({
          id: "patient-name-mismatch",
          severity: "warning",
          title: "Confirm patient identity",
          detail: msg,
          count: 1,
        });
      }
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

    return {
      alerts,
      blockingAlerts: alerts.filter((a) => a.blocking),
      needsPharmacistPin,
      softRxWarnings,
    };
  }, [lines, prescription, customer, mode, canDispenseControlled]);
}
