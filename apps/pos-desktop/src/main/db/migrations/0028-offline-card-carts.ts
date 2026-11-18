import type { Migration } from "../migrator";

/**
 * P4 #50: the cart an offline card payment was prepared for. The signed attempt carries only the
 * cart's digest, so without this a card left on the machine when Sell closed (a person switched,
 * the window reloaded, the app restarted) could not be shown again: the customer may have paid,
 * and the counter could neither finish that sale nor record the charge as not used. Local only,
 * never uploaded; the digest in the signed attempt is still what the sale is checked against.
 */
export const offlineCardCarts: Migration = {
  version: 28,
  name: "offline-card-carts",
  up(db) {
    db.exec(`
      CREATE TABLE offline_card_cart (
        attempt_id         TEXT PRIMARY KEY,
        enrollment_id      TEXT NOT NULL,
        checkout_draft_id  TEXT NOT NULL,
        items_json         TEXT NOT NULL,
        created_at         TEXT NOT NULL
      ) STRICT;
    `);
  },
};
