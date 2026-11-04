import type { Migration } from "../migrator";

/**
 * P2b #103: who co-signed a checkout's discount over the limit. As for the pharmacist co-signer
 * (0006), only the person is kept, never their PIN, so an unconfirmed sale that never reached the
 * server can ask the same manager again.
 */
export const checkoutDiscountCoSigner: Migration = {
  version: 10,
  name: "checkout-discount-co-signer",
  up(db) {
    db.exec("ALTER TABLE checkout_draft ADD COLUMN discount_co_signer_id TEXT");
  },
};
