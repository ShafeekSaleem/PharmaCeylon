-- Decided 2026-10-29: every counter role holds the desktop-counter route gate by default.
-- `terminal.execute` only reaches /terminal-commands/*; each signed command still needs its own
-- operation permission (stocktakes.review, transfers.manage, sales.refund, ...), so this grants
-- no new physical capability by itself.

UPDATE "permission"
SET "label" = 'Use the desktop counter for physical steps',
    "description" = 'Send signed commands from an enrolled desktop counter: stock posting, transfer dispatch and receipt, and refunds. Each command also needs that operation''s own permission.'
WHERE "key" = 'terminal.execute';

-- Built-in system roles only. Custom roles keep what their tenant chose; a tenant that already
-- removed the key from a built-in role gets it back here, as with any new default.
INSERT INTO "role_permission" ("id", "tenant_id", "role_id", "permission_key")
SELECT gen_random_uuid(), r."tenant_id", r."id", 'terminal.execute'
FROM "role" r
WHERE r."is_system" = true
  AND r."key" IN ('owner', 'manager', 'pharmacist', 'cashier', 'inventory_clerk')
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
