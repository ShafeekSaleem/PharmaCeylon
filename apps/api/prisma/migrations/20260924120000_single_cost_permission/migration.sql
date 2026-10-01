-- Seeing what something cost is one permission for the whole app, not one per module.
--
-- `inventory.view_cost` and `purchasing.view_cost` answered the same question on different
-- screens, so a role could be denied cost in Inventory and shown it on a purchase order — which
-- is what happened in testing. They collapse into `costs.view`, which governs batch costs and
-- stock valuation, unit costs and order values, supplier prices on an order line, stocktake
-- variance values, and any margin derived from them.

INSERT INTO "permission" ("key", "module", "label", "description") VALUES
  ('costs.view', 'costs', 'See costs and margins',
   'What stock cost and what it earns, everywhere in the app: batch costs and stock valuation, unit costs and order values, supplier prices on an order line, stocktake variance values, and any margin worked out from them. One permission rather than one per screen — without it the API leaves every such figure out, and the pages show a dash.')
ON CONFLICT ("key") DO NOTHING;

-- Anyone who could see a cost anywhere keeps seeing it: the union of the two old grants, so no
-- role loses an ability it had. A tenant that wants a narrower rule now has one switch to throw.
INSERT INTO "role_permission" ("id", "tenant_id", "role_id", "permission_key")
SELECT DISTINCT gen_random_uuid(), rp."tenant_id", rp."role_id", 'costs.view'
FROM "role_permission" rp
WHERE rp."permission_key" IN ('inventory.view_cost', 'purchasing.view_cost')
ON CONFLICT ("role_id", "permission_key") DO NOTHING;

-- The old keys go, so nothing can be granted against them again and no screen can quietly keep
-- reading one of them.
DELETE FROM "role_permission"
WHERE "permission_key" IN ('inventory.view_cost', 'purchasing.view_cost');

DELETE FROM "permission"
WHERE "key" IN ('inventory.view_cost', 'purchasing.view_cost');
