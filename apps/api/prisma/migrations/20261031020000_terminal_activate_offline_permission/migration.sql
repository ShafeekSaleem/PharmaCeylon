-- Revised D13 local activation: confirming, at the exact enrolled counter, that it becomes the
-- branch's offline-capable terminal. Separate from the owner/delegated-manager authorization.
INSERT INTO "permission" ("key", "module", "label", "description") VALUES
  ('terminal.activate_offline', 'terminal', 'Activate the offline counter at the counter',
   'Confirm, at the enrolled counter an owner or delegated manager authorized, that it becomes the branch''s offline-capable counter. Needs verified local attendance.')
ON CONFLICT ("key") DO NOTHING;

-- Built-in owner and manager roles, matching the catalog defaults. Custom roles opt in.
INSERT INTO "role_permission" ("id", "tenant_id", "role_id", "permission_key")
SELECT gen_random_uuid(), r."tenant_id", r."id", 'terminal.activate_offline'
FROM "role" r
WHERE r."is_system" = true AND r."key" IN ('owner', 'manager')
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
