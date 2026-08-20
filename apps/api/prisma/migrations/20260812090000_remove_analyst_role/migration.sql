-- Data cleanup: remove analyst role assignments and seeded analyst Role rows
-- before dropping the enum value — Postgres can't cast rows still holding it.
DELETE FROM "user_branch_role" WHERE "role" = 'analyst';
DELETE FROM "role" WHERE "key" = 'analyst';

-- AlterEnum: drop 'analyst' from RoleName. Postgres has no ALTER TYPE ... DROP
-- VALUE, so the type is recreated without it and the column repointed.
CREATE TYPE "RoleName_new" AS ENUM ('owner', 'manager', 'pharmacist', 'cashier', 'inventory_clerk', 'custom');
ALTER TABLE "user_branch_role" ALTER COLUMN "role" TYPE "RoleName_new" USING ("role"::text::"RoleName_new");
DROP TYPE "RoleName";
ALTER TYPE "RoleName_new" RENAME TO "RoleName";
