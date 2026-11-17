import type { Migration } from "../migrator";

/**
 * P4 #50: one row per sale committed offline, keyed by the checkout draft it finished. It makes
 * committing idempotent (a second tap on Pay returns the same sale, never a second one) and keeps
 * the receipt the customer was given, in the counter's own figures. The sale itself is the
 * journal entry it names; this row is derived from it and never uploaded. No foreign key: D11's
 * journal recovery moves entries to `offline_journal_set_aside`, and the receipt the customer
 * holds stays on record either way.
 */
export const offlineSaleReceipts: Migration = {
  version: 24,
  name: "offline-sale-receipts",
  up(db) {
    db.exec(`
      CREATE TABLE offline_sale_receipt (
        checkout_draft_id  TEXT PRIMARY KEY,
        enrollment_id      TEXT NOT NULL,
        command_id         TEXT NOT NULL UNIQUE,
        receipt_json       TEXT NOT NULL,
        created_at         TEXT NOT NULL
      ) STRICT;
      CREATE INDEX offline_sale_receipt_enrollment ON offline_sale_receipt (enrollment_id);
    `);
  },
};
