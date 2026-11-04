-- P2b #103: a line discount over the tenant's `pos_max_discount_percent` names who approved it,
-- separately from the seller (revised D10). Nullable: within the limit nobody approves.
ALTER TABLE "sale" ADD COLUMN "discount_approved_by" UUID;
ALTER TABLE "sale" ADD CONSTRAINT "sale_discount_approved_by_fkey" FOREIGN KEY ("discount_approved_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Approving a discount over the limit was a hardcoded owner/manager check. It is now a permission,
-- granted to the same built-in roles, so a tenant can give it to a custom role.
INSERT INTO "permission" ("key", "module", "label", "description") VALUES
  ('sales.discount_override', 'sales', 'Approve discounts over the limit',
   'Give, or co-sign with a till PIN, a line discount above the POS discount limit in Settings.')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permission" ("id", "tenant_id", "role_id", "permission_key")
SELECT gen_random_uuid(), r."tenant_id", r."id", 'sales.discount_override'
FROM "role" r
WHERE r."is_system" = true AND r."key" IN ('owner', 'manager')
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
