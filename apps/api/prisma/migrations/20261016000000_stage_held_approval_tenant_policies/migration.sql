-- Complete the staged tenant-policy inventory for held approval workflows.
-- Policies remain inactive: this migration does not enable or force RLS.
CREATE POLICY "pc_tenant_isolation" ON "held_delivery"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "pc_tenant_isolation" ON "held_adjustment"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
