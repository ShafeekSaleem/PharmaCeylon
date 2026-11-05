import type { ShiftSummary } from "../../shared/ipc-contract";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const money = (minor: number) => {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100).toLocaleString("en-LK")}.${String(abs % 100).padStart(2, "0")}`;
};

const METHOD: Record<string, string> = {
  cash: "Cash",
  card: "Card",
  mobile_wallet: "Mobile wallet",
  credit: "On account",
};

export type XReportInput = {
  branchName: string;
  counterLabel: string;
  shiftNumber: string | null;
  staffName: string;
  openedAt: string;
  printedAt: Date;
  printedBy: string;
  summary: ShiftSummary;
  /** False when the server couldn't be asked and the counter's last copy is printed. */
  current: boolean;
};

/**
 * An X report: a mid-shift summary on the receipt printer. The shift stays open; nothing is
 * counted or closed. Printed from the server's figures, or the counter's last copy of them.
 */
export function renderXReportHtml(input: XReportInput): string {
  const { summary } = input;
  const row = (label: string, value: string, cls = "") =>
    `<tr${cls ? ` class="${cls}"` : ""}><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`;
  const takings = summary.takingsByMethod
    .map((m) => row(`${METHOD[m.method] ?? m.method} (${m.saleCount})`, money(m.takenMinor)))
    .join("\n");
  const refunds = summary.takingsByMethod
    .filter((m) => m.refundedMinor > 0)
    .map((m) => row(`${METHOD[m.method] ?? m.method} refunds`, `-${money(m.refundedMinor)}`))
    .join("\n");
  const hours = summary.takingsByHour
    .map((h) => row(`${h.hour.slice(11)}:00 (${h.saleCount})`, money(h.totalMinor)))
    .join("\n");
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
  .total td { font-weight: bold; }
</style>
</head>
<body>
<h1>${escapeHtml(input.branchName)}</h1>
<p>${escapeHtml(input.counterLabel)}</p>
<p>X REPORT — SHIFT STILL OPEN</p>
${input.current ? "" : "<p>NOT YET SYNCED: LAST FIGURES THIS COUNTER HAD</p>"}
<table>
${row("Shift", input.shiftNumber ?? "-")}
${row("Cashier", input.staffName)}
${row("Opened", new Date(input.openedAt).toLocaleString())}
${row("Printed", input.printedAt.toLocaleString())}
${row("Printed by", input.printedBy)}
</table>
<hr>
<table>
${row(`Sales (${summary.saleCount})`, money(summary.salesTotalMinor), "total")}
${takings}
${refunds}
</table>
<hr>
<table>
${row("Opening cash", money(summary.openingCashMinor))}
${row("Cash taken", money(summary.cashTakenMinor))}
${row("Change given", `-${money(summary.changeGivenMinor)}`)}
${row("Cash refunds", `-${money(summary.cashRefundsMinor)}`)}
${row("Cash paid out", `-${money(summary.cashPaidOutMinor)}`)}
${summary.cashPaidInMinor ? row("Cash paid in", money(summary.cashPaidInMinor)) : ""}
${row("Expected in drawer", money(summary.expectedCashMinor), "total")}
</table>
${hours ? `<hr>\n<p>Takings by hour</p>\n<table>\n${hours}\n</table>` : ""}
<hr>
<p>Not a close. Count the drawer when the shift ends.</p>
</body>
</html>`;
}
