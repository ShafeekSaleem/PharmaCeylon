-- Who may approve their own requests is the rule that holds everyone else to a second pair of
-- eyes, so it cannot sit behind the same key as the rest of the tenant settings: a manager with
-- `tenant.management` could add their own role to the list and approve their own purchase
-- orders from then on. It gets its own permission, and only the owner starts with it.

INSERT INTO "permission" ("key", "module", "label", "description") VALUES
  ('tenant.approval_rules', 'tenant', 'Change who may approve their own requests',
   'Decide which roles may approve requests they raised themselves (Settings → Approval Rules). Owner-only by default: a manager who can grant it to their own role is not being held to it.')
ON CONFLICT ("key") DO NOTHING;

-- Only the built-in owner role. Deliberately not granted to managers or to custom roles that
-- hold `tenant.management`, because narrowing this is the whole point of the change — an owner
-- who wants someone else to have it can grant it in Users & Roles.
INSERT INTO "role_permission" ("id", "tenant_id", "role_id", "permission_key")
SELECT gen_random_uuid(), r."tenant_id", r."id", 'tenant.approval_rules'
FROM "role" r
WHERE r."is_system" = true AND r."key" = 'owner'
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
