"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { IconPrinter } from "@/components/icons";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { formatMoney } from "@/lib/money";
import { fetchTenantSettings } from "../../settings/lib/tenant-settings";
import { PAYMENT_METHOD_LABELS } from "../constants";
import type { SaleDetail } from "../types";
import { formatDateTime } from "../utils";
import css from "../sales.module.css";

type ReceiptPreferences = {
  paperSize: string;
  headerText: string | null;
  footerText: string | null;
  showLogo: boolean;
  showVatBreakdown: boolean;
  showStaffName: boolean;
};

type Organization = { displayName: string; logoUrl: string | null };

const DEFAULT_PREFERENCES: ReceiptPreferences = {
  paperSize: "80mm",
  headerText: null,
  footerText: null,
  showLogo: true,
  showVatBreakdown: true,
  showStaffName: true,
};

/** The tenant's receipt layout (Settings → Point of Sale & Receipts), so a copy looks like the original. */
function useReceiptLayout(enabled: boolean) {
  const [preferences, setPreferences] = useState(DEFAULT_PREFERENCES);
  const [organization, setOrganization] = useState<Organization | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchTenantSettings()
      .then((settings) => {
        if (cancelled) return;
        setPreferences({
          paperSize: settings.receiptPaperSize,
          headerText: settings.receiptHeaderText,
          footerText: settings.receiptFooterText,
          showLogo: settings.receiptShowLogo,
          showVatBreakdown: settings.receiptShowVatBreakdown,
          showStaffName: settings.receiptShowStaffName,
        });
      })
      .catch(() => {});
    apiJson<Organization>("/tenant/profile")
      .then((profile) => {
        if (!cancelled) setOrganization(profile);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { preferences, organization };
}

function ReceiptBody({
  sale,
  preferences,
  organization,
  printedAt,
}: {
  sale: SaleDetail;
  preferences: ReceiptPreferences;
  organization: Organization | null;
  printedAt: string;
}) {
  const showLogo = preferences.showLogo && organization?.logoUrl;
  return (
    <div className={css.receipt}>
      {/* A copy must never pass for the original: the mark heads every screen and print of it. */}
      <div className={css.copyMark}>
        Copy
        <small>Not the original receipt · printed {formatDateTime(printedAt)}</small>
      </div>

      {showLogo || preferences.headerText || organization?.displayName ? (
        <div className={css.receiptBrand}>
          {/* A plain <img>, like the till's receipts: it has to print as-is, not lazy-load. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {showLogo ? <img src={organization!.logoUrl!} alt="" /> : null}
          <strong>{preferences.headerText || organization?.displayName}</strong>
        </div>
      ) : null}

      <div className={css.receiptHead}>
        <span className={css.receiptTitle}>{sale.invoiceNo}</span>
        <span className={css.receiptSub}>
          {formatDateTime(sale.soldAt)} · {sale.branch.name}
          {preferences.showStaffName ? ` · ${sale.seller.fullName}` : ""}
        </span>
        <span className={css.receiptSub}>
          {sale.customer ? sale.customer.fullName : "Walk-in customer"}
          {sale.prescription
            ? ` · Rx ${sale.prescription.rxNumber} (${sale.prescription.patientName})`
            : ""}
          {preferences.showStaffName && sale.dispenser ? ` · Dispensed by ${sale.dispenser.fullName}` : ""}
        </span>
      </div>

      <table className={css.receiptTable}>
        <thead>
          <tr>
            <th>Item</th>
            <th>Qty</th>
            <th className={css.right}>Total</th>
          </tr>
        </thead>
        <tbody>
          {sale.items.map((item) => (
            <tr key={item.id}>
              <td>
                {item.product.name}
                <div className={css.receiptSub}>Batch {item.batch.batchNo}</div>
              </td>
              <td>{item.qty}</td>
              <td className={`${css.right} ${css.amount}`}>{formatMoney(item.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className={css.receiptTotals}>
        <div className={css.summaryRow}>
          <span>Subtotal</span>
          <span className={css.amount}>{formatMoney(sale.subtotal)}</span>
        </div>
        <div className={css.summaryRow}>
          <span>Discount</span>
          <span className={css.amount}>- {formatMoney(sale.discountTotal)}</span>
        </div>
        {preferences.showVatBreakdown ? (
          <div className={css.summaryRow}>
            <span>VAT</span>
            <span className={css.amount}>{formatMoney(sale.taxTotal)}</span>
          </div>
        ) : null}
        <div className={css.summaryGrand}>
          <span>Total</span>
          <span className={css.amount}>{formatMoney(sale.grandTotal)}</span>
        </div>
        {/* What was tendered at the till; later refunds are on the sale, not on its receipt. */}
        {sale.payments
          .filter((payment) => Number(payment.amount) > 0)
          .map((payment) => (
            <div key={payment.id} className={css.summaryRow}>
              <span>{PAYMENT_METHOD_LABELS[payment.method] ?? payment.method}</span>
              <span className={css.amount}>{formatMoney(payment.amount)}</span>
            </div>
          ))}
        <div className={css.summaryRow}>
          <span>Change</span>
          <span className={css.amount}>{formatMoney(sale.changeDue)}</span>
        </div>
      </div>

      {sale.notes ? <p className={css.receiptSub}>Note: {sale.notes}</p> : null}
      {preferences.footerText ? <p className={css.receiptFooter}>{preferences.footerText}</p> : null}
    </div>
  );
}

type Props = {
  sale: SaleDetail | null;
  open: boolean;
  onClose: () => void;
};

/**
 * A copy of a sale's receipt, in the tenant's receipt layout and marked "Copy" on screen and on
 * paper. Printing goes through the browser's dialog, which is also how it's saved as a PDF.
 */
export function SaleReceiptCopy({ sale, open, onClose }: Props) {
  const { preferences, organization } = useReceiptLayout(open);
  const [printedAt, setPrintedAt] = useState(() => new Date().toISOString());

  useEffect(() => {
    if (open) setPrintedAt(new Date().toISOString());
    else document.body.classList.remove(css.printingReceipt);
  }, [open]);

  const print = useCallback(() => {
    setPrintedAt(new Date().toISOString());
    const body = document.body;
    const done = () => {
      body.classList.remove(css.printingReceipt);
      window.removeEventListener("afterprint", done);
    };
    // The class only matters under `@media print`, so if a browser never fires afterprint the
    // screen is unaffected; it's cleared on the next print or when this closes.
    body.classList.add(css.printingReceipt);
    window.addEventListener("afterprint", done);
    // Let the new print time render into the copy before the dialog snapshots the page.
    window.setTimeout(() => window.print(), 50);
  }, []);

  const showing = open && sale !== null;

  return (
    <>
      <Modal
        open={showing}
        onClose={onClose}
        title="Receipt copy"
        description={sale ? `${sale.invoiceNo} · ${sale.branch.name}` : undefined}
        size="md"
        footer={
          <ModalFooter>
            <ModalButton onClick={onClose}>Close</ModalButton>
            <ModalButton variant="primary" onClick={print}>
              <IconPrinter size={14} /> Print or save as PDF
            </ModalButton>
          </ModalFooter>
        }
      >
        {sale ? (
          <ReceiptBody sale={sale} preferences={preferences} organization={organization} printedAt={printedAt} />
        ) : null}
      </Modal>
      {showing && typeof document !== "undefined"
        ? createPortal(
            <div className={css.printRoot} data-paper-size={preferences.paperSize} data-testid="receipt-print-copy">
              <ReceiptBody sale={sale} preferences={preferences} organization={organization} printedAt={printedAt} />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
