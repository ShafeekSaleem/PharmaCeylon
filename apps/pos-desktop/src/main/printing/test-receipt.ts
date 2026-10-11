import { BrowserWindow } from "electron";
import type { PrintResult } from "../../shared/ipc-contract";
import { renderTestReceiptHtml } from "./receipt-html";

export async function printTestReceipt(printerName: string, appVersion: string): Promise<PrintResult> {
  // A throwaway window that can run no script and reach no bridge.
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  try {
    const printers = await window.webContents.getPrintersAsync();
    if (!printers.some((printer) => printer.name === printerName)) {
      return { ok: false, error: "That printer is no longer available." };
    }

    const html = renderTestReceiptHtml({ printerName, printedAt: new Date(), appVersion });
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    return await new Promise<PrintResult>((resolve) => {
      window.webContents.print(
        { silent: true, deviceName: printerName, printBackground: false, margins: { marginType: "none" } },
        (success, failureReason) =>
          resolve(
            success
              ? { ok: true, error: null }
              : { ok: false, error: failureReason || "The printer did not accept the job." },
          ),
      );
    });
  } finally {
    window.destroy();
  }
}
