import type { Migration } from "../migrator";

/**
 * P4 #50: when an offline sale's receipt first printed. Every print after that is marked as a
 * reprint on the paper, even after a restart, so a second copy can't pass for a second sale. A
 * print that failed sets nothing: the next attempt is still the original.
 */
export const offlineReceiptPrinted: Migration = {
  version: 29,
  name: "offline-receipt-printed",
  up(db) {
    db.exec(`ALTER TABLE offline_sale_receipt ADD COLUMN printed_at TEXT;`);
  },
};
