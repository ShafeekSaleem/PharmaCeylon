import type { Migration } from "../migrator";

/**
 * P2b #103: the last test receipt confirmed at this enrollment, cached with the other enrollment
 * status facts so This counter still shows it after a restart while offline.
 */
export const enrollmentTestReceiptCache: Migration = {
  version: 30,
  name: "enrollment-test-receipt-cache",
  up(db) {
    db.exec(
      `ALTER TABLE device_identity ADD COLUMN enrollment_last_test_receipt_json TEXT;`,
    );
  },
};
