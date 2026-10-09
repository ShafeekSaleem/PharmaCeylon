-- CreateEnum
CREATE TYPE "ReturnDisposition" AS ENUM ('restock', 'quarantine');

-- AlterTable
ALTER TABLE "goods_return_item" ADD COLUMN     "disposition" "ReturnDisposition" NOT NULL DEFAULT 'restock';

-- Refunding at the till was decided by role name inside the sales service (owner, manager,
-- pharmacist, cashier), so a tenant could never give it to a custom role or take it from one of
-- those. It is a permission now, granted to the same four built-in roles it was hardcoded to.
INSERT INTO "permission" ("key", "module", "label", "description") VALUES
  ('sales.refund', 'sales', 'Refund sales',
   'Refund a sale at the till, choosing whether each returned item goes back on the shelf or is held for inspection. Controlled and prescription items also need "Approve controlled substance sales".')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permission" ("id", "tenant_id", "role_id", "permission_key")
SELECT gen_random_uuid(), r."tenant_id", r."id", 'sales.refund'
FROM "role" r
WHERE r."is_system" = true AND r."key" IN ('owner', 'manager', 'pharmacist', 'cashier')
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
