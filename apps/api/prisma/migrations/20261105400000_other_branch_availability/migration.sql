-- Decided 2026-11-05 (#103): at the counter, every other branch of the tenant shows as In stock,
-- Low or Out for a product (controlled items: "Ask the pharmacist"). No quantities, costs or
-- batches. On by default for the counter roles, so an owner can switch it off per role.
--
-- First merged as 20261105300000_other_branch_availability, which shared its timestamp with
-- 20261105300000_prescription_checked_by, and renamed to this. A database that already ran the
-- old name runs this one too, so the grant happens only when this statement adds the permission:
-- re-running it must not hand the permission back to a role an owner has since switched it off.
WITH added AS (
  INSERT INTO "permission" ("key", "module", "label", "description") VALUES
    ('inventory.view_other_branches_availability', 'inventory',
     'See whether other branches have a product',
     'At the counter, show every other branch as In stock, Low or Out for a product. No quantities, costs or batches; controlled items show "Ask the pharmacist".')
  ON CONFLICT ("key") DO NOTHING
  RETURNING "key"
)
-- Built-in system roles only. Custom roles keep what their tenant chose.
INSERT INTO "role_permission" ("id", "tenant_id", "role_id", "permission_key")
SELECT gen_random_uuid(), r."tenant_id", r."id", added."key"
FROM "role" r CROSS JOIN added
WHERE r."is_system" = true AND r."key" IN ('owner', 'manager', 'pharmacist', 'cashier')
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
