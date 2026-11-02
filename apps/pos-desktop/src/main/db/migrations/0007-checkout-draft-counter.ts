import type { Migration } from "../migrator";

/**
 * The branch and enrollment a checkout was rung up on. A draft is resent only from the same
 * enrollment, so a counter re-enrolled at another branch can't post an old sale there.
 */
export const checkoutDraftCounter: Migration = {
  version: 7,
  name: "checkout-draft-counter",
  up(db) {
    db.exec("ALTER TABLE checkout_draft ADD COLUMN branch_id TEXT");
    db.exec("ALTER TABLE checkout_draft ADD COLUMN enrollment_id TEXT");
  },
};
