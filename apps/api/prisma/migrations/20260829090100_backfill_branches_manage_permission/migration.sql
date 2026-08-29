-- New permission key `tenant.branches_manage` (Settings → General → Branches: create/edit).
-- `ensureRbacSeed()` (prisma/rbac-seed.ts) only grants a new catalog key's defaultRoles when a
-- tenant's Role row is first created, so it never reaches existing tenants. Backfill it here,
-- the same way 20260812090000_remove_analyst_role backfilled an RBAC change onto live rows.

INSERT INTO "permission" ("key", "module", "label", "description")
VALUES (
  'tenant.branches_manage',
  'tenant',
  'Manage branches',
  'Create and edit the tenant''s branch list.'
)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permission" ("id", "tenant_id", "role_id", "permission_key")
SELECT gen_random_uuid(), r."tenant_id", r."id", 'tenant.branches_manage'
FROM "role" r
WHERE r."key" IN ('owner', 'manager') AND r."is_system" = true
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
