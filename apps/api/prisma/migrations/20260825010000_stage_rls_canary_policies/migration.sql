-- Phase 4 canary: install policies without enabling RLS.
--
-- These policies are inert until a later, controlled migration runs
-- ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY. Staging them now lets CI
-- validate the policy inventory without changing production query behaviour.

DROP POLICY IF EXISTS "pc_tenant_canary" ON "product";
CREATE POLICY "pc_tenant_canary" ON "product"
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

DROP POLICY IF EXISTS "pc_tenant_branch_canary" ON "batch";
CREATE POLICY "pc_tenant_branch_canary" ON "batch"
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND (
      NULLIF(current_setting('app.branch_id', true), '') IS NULL
      OR "branch_id" = NULLIF(current_setting('app.branch_id', true), '')::uuid
    )
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND (
      NULLIF(current_setting('app.branch_id', true), '') IS NULL
      OR "branch_id" = NULLIF(current_setting('app.branch_id', true), '')::uuid
    )
  );

DROP POLICY IF EXISTS "pc_tenant_branch_canary" ON "sale";
CREATE POLICY "pc_tenant_branch_canary" ON "sale"
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND (
      NULLIF(current_setting('app.branch_id', true), '') IS NULL
      OR "branch_id" = NULLIF(current_setting('app.branch_id', true), '')::uuid
    )
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND (
      NULLIF(current_setting('app.branch_id', true), '') IS NULL
      OR "branch_id" = NULLIF(current_setting('app.branch_id', true), '')::uuid
    )
  );

COMMENT ON POLICY "pc_tenant_canary" ON "product" IS
  'Phase 4 staged canary; RLS remains disabled until access-path migration is approved.';
COMMENT ON POLICY "pc_tenant_branch_canary" ON "batch" IS
  'Phase 4 staged canary; RLS remains disabled until access-path migration is approved.';
COMMENT ON POLICY "pc_tenant_branch_canary" ON "sale" IS
  'Phase 4 staged canary; RLS remains disabled until access-path migration is approved.';
