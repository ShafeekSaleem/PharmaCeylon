-- Phase 6 follow-up: stage the same tenant-only policy on `tenant_settings`, the one new
-- tenant-owned table added since the Phase 6 policy inventory migration. RLS remains
-- disabled pending the staged rollout (see 20260825050000_stage_complete_tenant_policy_inventory).

DROP POLICY IF EXISTS "pc_tenant_isolation" ON "tenant_settings";

CREATE POLICY "pc_tenant_isolation" ON "tenant_settings"
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

COMMENT ON POLICY "pc_tenant_isolation" ON "tenant_settings" IS
  'Phase 6 staged tenant policy; RLS remains disabled pending staged rollout.';
