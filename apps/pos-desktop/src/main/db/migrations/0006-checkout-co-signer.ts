import type { Migration } from "../migrator";

/**
 * Who co-signed a checkout's controlled items. Only the person is kept, never their PIN, so an
 * unconfirmed sale that never reached the server can ask the same pharmacist again.
 */
export const checkoutCoSigner: Migration = {
  version: 6,
  name: "checkout-co-signer",
  up(db) {
    db.exec("ALTER TABLE checkout_draft ADD COLUMN co_signer_id TEXT");
  },
};
