-- Agreeing what a supplier charges is a commercial decision, not a stock one.
--
-- The price list was readable by anyone with `purchasing.view_cost` and editable by anyone with
-- `suppliers.manage` — both of which a stock clerk holds by default, so a clerk could change
-- what the pharmacy believes it has agreed to pay. It gets its own permission, granted to
-- owners and managers.

INSERT INTO "permission" ("key", "module", "label", "description") VALUES
  ('suppliers.manage_prices', 'suppliers', 'Agree supplier prices',
   'See and change a supplier''s price list. Agreeing what a supplier charges is a commercial decision, so it is separate from managing the supplier record.')
ON CONFLICT ("key") DO NOTHING;

-- Built-in owners and managers get it. Custom roles that a tenant had already trusted with
-- supplier management keep it, because that was a deliberate choice someone made; the built-in
-- inventory clerk does not, which is the change.
INSERT INTO "role_permission" ("id", "tenant_id", "role_id", "permission_key")
SELECT gen_random_uuid(), r."tenant_id", r."id", 'suppliers.manage_prices'
FROM "role" r
WHERE (r."is_system" = true AND r."key" IN ('owner', 'manager'))
   OR (r."is_system" = false AND EXISTS (
     SELECT 1 FROM "role_permission" rp
     WHERE rp."role_id" = r."id" AND rp."permission_key" = 'suppliers.manage'
   ))
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
