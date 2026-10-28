-- Route-level gate for the signed desktop command endpoints (/terminal-commands/prepare and
-- /execute). Each command is still checked against its own operation permission inside the
-- executor; this key only stops branch users who hold none of them reaching that path.

INSERT INTO "permission" ("key", "module", "label", "description") VALUES
  ('terminal.execute', 'terminal', 'Post stock from the desktop counter',
   'Send signed posting commands (stocktake, write-off, held delivery, import stock) from an enrolled desktop counter. Each command also needs that operation''s own permission.')
ON CONFLICT ("key") DO NOTHING;

-- Every role, built-in or custom, that can already perform one of the signed v1 operations, so
-- nobody loses a capability they hold today. No other role gains it.
INSERT INTO "role_permission" ("id", "tenant_id", "role_id", "permission_key")
SELECT gen_random_uuid(), r."tenant_id", r."id", 'terminal.execute'
FROM "role" r
WHERE EXISTS (
  SELECT 1 FROM "role_permission" rp
  WHERE rp."role_id" = r."id"
    AND rp."permission_key" IN ('stocktakes.review', 'inventory.write_off', 'purchasing.receive', 'products.import')
)
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
