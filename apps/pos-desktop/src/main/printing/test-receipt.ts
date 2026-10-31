import type { PrintResult } from "../../shared/ipc-contract";
import { printHtml } from "./print-html";
import { renderTestReceiptHtml } from "./receipt-html";

export function printTestReceipt(printerName: string, appVersion: string): Promise<PrintResult> {
  return printHtml(printerName, renderTestReceiptHtml({ printerName, printedAt: new Date(), appVersion }));
}
