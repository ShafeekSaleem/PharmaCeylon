-- W7: the two things a prepared local manager may do while a counter is offline (D8 after-hours
-- acknowledgement, assisted shift handover). They are role permissions so custom roles work;
-- P3 signs them into the offline grant for each prepared staff member who holds them.

INSERT INTO "permission" ("key", "module", "label", "description") VALUES
  ('sales.offline_hours_acknowledge', 'sales', 'Acknowledge after-hours selling offline',
   'While a counter is offline, let selling continue past routine closing time with a reason and end time. Never overrides mandatory restrictions or the 24-hour offline permission. Applies to counters after their next sync.'),
  ('sales.offline_handover_assist', 'sales', 'Close an absent cashier''s shift offline',
   'While a counter is offline, count and close an absent cashier''s shift under their own sign-in, keeping the cashier''s sales and any shortage. Applies to counters after their next sync.')
ON CONFLICT ("key") DO NOTHING;

-- Built-in owner and manager roles only, matching the catalog defaults. Custom roles start
-- without them; an owner grants them in Users & Roles.
INSERT INTO "role_permission" ("id", "tenant_id", "role_id", "permission_key")
SELECT gen_random_uuid(), r."tenant_id", r."id", p.key
FROM "role" r
CROSS JOIN (VALUES ('sales.offline_hours_acknowledge'), ('sales.offline_handover_assist')) AS p(key)
WHERE r."is_system" = true AND r."key" IN ('owner', 'manager')
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
