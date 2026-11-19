import { formatDisplayDateTime } from "@pharmaceylon/shared";
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Where a receipt was printed, and the pharmacy's accent for its header (UI1 #205). */
export type ReceiptPlace = { branchName: string; counterLabel: string; accent?: string | null };

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * The header: branch name in the pharmacy's accent over a rule in the same colour. Every accent an
 * owner can save reaches 4.5:1 on white, so on a one-colour thermal printer it still prints as solid
 * dark text. Anything that is not a plain hex colour is left out rather than put in the style.
 */
function receiptHeader(place: ReceiptPlace): string {
  const accent = place.accent && HEX.test(place.accent) ? place.accent.toLowerCase() : null;
  const style = accent ? ` style="color: ${accent}; border-bottom: 2px solid ${accent};"` : "";
  return `<header class="brand"${style}>
<h1>${escapeHtml(place.branchName)}</h1>
</header>
<p>${escapeHtml(place.counterLabel)}</p>`;
}

const RECEIPT_STYLE = `
  body { font: 12px/1.4 Consolas, monospace; margin: 0; padding: 4mm; color: #000; }
  h1 { font-size: 14px; text-align: center; margin: 0 0 2mm; }
  .brand { margin: 0 0 2mm; }
  .brand h1 { color: inherit; margin: 0 0 1mm; }
  p { text-align: center; margin: 0 0 2mm; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 0.5mm 0; vertical-align: top; }
  td:last-child { text-align: right; }
  hr { border: 0; border-top: 1px dashed #000; margin: 2mm 0; }
  .total td { font-weight: bold; }
  .reprint { font-weight: bold; border: 1px solid #000; padding: 1mm 0; }`;

export type ReceiptSale = {
  invoiceNo: string;
  soldAt: string;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  grandTotal: string;
  amountPaid: string;
  changeDue: string;
  sellerName: string;
  /** Who approved a discount over the limit (P2b #103), printed beside the seller. */
  discountApproverName?: string | null;
  lines: { name: string; qty: number; unitPrice: string; discountAmount?: string; lineTotal: string }[];
  payments: { method: string; amount: string; reference: string | null }[];
};

/** A customer receipt for a completed sale, from the server's own totals. */
export function renderSaleReceiptHtml(
  sale: ReceiptSale,
  place: ReceiptPlace,
  /** A copy of a receipt already printed: marked, so it can't pass for a second sale. */
  options: { reprint?: boolean } = {},
): string {
  const row = (label: string, value: string, cls = "") =>
    `<tr${cls ? ` class="${cls}"` : ""}><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`;
  const lines = sale.lines
    // The line's discount on its own row, under the amount it's taken from (the line total is net).
    .map((l) => {
      const discounted = l.discountAmount && Number(l.discountAmount) > 0;
      return `${row(l.name, "")}${row(`  ${l.qty} x ${l.unitPrice}`, discounted ? "" : l.lineTotal)}${
        discounted ? row(`  Discount -${l.discountAmount}`, l.lineTotal) : ""
      }`;
    })
    .join("\n");
  const payments = sale.payments
    .map((p) => row(p.method === "card" ? `Card${p.reference ? ` (${p.reference})` : ""}` : "Cash", p.amount))
    .join("\n");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>${RECEIPT_STYLE}</style>
</head>
<body>
${receiptHeader(place)}
${options.reprint ? `<p class="reprint">REPRINT</p>` : ""}
<table>
${row("Invoice", sale.invoiceNo)}
${row("Date", formatDisplayDateTime(sale.soldAt))}
${row("Served by", sale.sellerName)}
${sale.discountApproverName ? row("Discount approved by", sale.discountApproverName) : ""}
</table>
<hr>
<table>
${lines}
</table>
<hr>
<table>
${row("Subtotal", sale.subtotal)}
${sale.discountTotal !== "0.00" ? row("Discount", `-${sale.discountTotal}`) : ""}
${row("Tax", sale.taxTotal)}
${row("Total", sale.grandTotal, "total")}
${payments}
${row("Change", sale.changeDue)}
</table>
<hr>
<p>Thank you</p>
</body>
</html>`;
}

export type SupplierCashPayoutReceipt = {
  payoutNumber: string;
  amountMinor: number;
  supplierPaymentId: string;
  supplierName: string | null;
  movementReason: string;
  executedAt: string;
};

function minorMoney(minor: number): string {
  return (minor / 100).toFixed(2);
}

/** Till receipt for a supplier cash payout executed on this counter. */
export function renderSupplierCashPayoutReceiptHtml(
  payout: SupplierCashPayoutReceipt,
  place: ReceiptPlace,
): string {
  const row = (label: string, value: string) =>
    `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>${RECEIPT_STYLE}</style>
</head>
<body>
${receiptHeader(place)}
<table>
${row("Receipt", "supplier_cash_payout.executed")}
${row("Supplier", payout.supplierName ?? "Supplier")}
${row("Payout", payout.payoutNumber)}
${row("Payment id", payout.supplierPaymentId)}
${row("Till cash out", payout.movementReason)}
${row("Amount", `Rs ${minorMoney(payout.amountMinor)}`)}
${row("Paid at", formatDisplayDateTime(payout.executedAt))}
</table>
<hr>
<p>Supplier cash payout</p>
</body>
</html>`;
}

export function renderTestReceiptHtml(input: { printerName: string; printedAt: Date; appVersion: string }): string {
  const row = (label: string, value: string) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font: 12px/1.4 Consolas, monospace; margin: 0; padding: 4mm; color: #000; }
  h1 { font-size: 14px; text-align: center; margin: 0 0 2mm; }
  p { text-align: center; margin: 0 0 2mm; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 0.5mm 0; vertical-align: top; }
  td:last-child { text-align: right; }
  hr { border: 0; border-top: 1px dashed #000; margin: 2mm 0; }
</style>
</head>
<body>
<h1>PharmaCeylon POS</h1>
<p>TEST RECEIPT — NOT A SALE</p>
<hr>
<table>
${row("Printer", input.printerName)}
${row("Printed", formatDisplayDateTime(input.printedAt))}
${row("App version", input.appVersion)}
</table>
<hr>
<p>If you can read this, the printer works.</p>
</body>
</html>`;
}
