import type { Migration } from "../migrator";

/**
 * P4 #50, receipt numbering option A: the number on an offline sale's receipt (`C1R-000186`),
 * final once the sale is committed. Kept beside the receipt so the next sale is numbered after the
 * highest one this store ever gave, even after a recovery set its journal entries aside; the
 * unique index stops two sales ever sharing a number here.
 */
export const offlineReceiptNumbers: Migration = {
  version: 26,
  name: "offline-receipt-numbers",
  up(db) {
    db.exec(`
      ALTER TABLE offline_sale_receipt ADD COLUMN receipt_number TEXT;
      CREATE UNIQUE INDEX offline_sale_receipt_number ON offline_sale_receipt (receipt_number);
    `);
  },
};
