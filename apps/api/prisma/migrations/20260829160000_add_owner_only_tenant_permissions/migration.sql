-- Two new owner-only permission keys:
--  - tenant.branches_create: creating new branch locations is now owner-only (managers can
--    still edit branches they hold the manager role on, via tenant.branches_manage, but can
--    no longer add new branches).
--  - tenant.profile_manage: editing the tenant's legal identity / compliance / operating
--    defaults (Settings -> Tenant Profile) is now owner-only.
-- `ensureRbacSeed()` (prisma/rbac-seed.ts) only grants a new catalog key's defaultRoles when a
-- tenant's Role row is first created, so it never reaches existing tenants. Backfill here, the
-- same way 20260829090100_backfill_branches_manage_permission backfilled the last one.

INSERT INTO "permission" ("key", "module", "label", "description")
VALUES
  ('tenant.branches_create', 'tenant', 'Create branches', 'Add new branch locations to the tenant.'),
  ('tenant.profile_manage', 'tenant', 'Edit tenant profile', 'Change the tenant''s legal identity, compliance, and operating defaults.')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permission" ("id", "tenant_id", "role_id", "permission_key")
SELECT gen_random_uuid(), r."tenant_id", r."id", p."key"
FROM "role" r
CROSS JOIN (VALUES ('tenant.branches_create'), ('tenant.profile_manage')) AS p("key")
WHERE r."key" = 'owner' AND r."is_system" = true
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
