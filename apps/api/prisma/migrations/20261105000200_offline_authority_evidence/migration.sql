-- P3 #49: offline authority is evidence P5 reconciles against, so it is kept like the other
-- offline-terminal records (20261029020000_offline_terminal_assignment).
--
-- 1. Each snapshot and issuance points at the enrollment it was issued to, and an issuance at a
--    snapshot of that same enrollment.
CREATE UNIQUE INDEX "terminal_enrollment_tenant_branch_id_key"
ON "terminal_enrollment" ("tenant_id", "branch_id", "id");

CREATE UNIQUE INDEX "offline_stock_snapshot_enrollment_id_key"
ON "offline_stock_snapshot" ("tenant_id", "branch_id", "enrollment_id", "id");

ALTER TABLE "offline_stock_snapshot" ADD CONSTRAINT "offline_stock_snapshot_enrollment_fkey"
  FOREIGN KEY ("tenant_id", "branch_id", "enrollment_id")
  REFERENCES "terminal_enrollment" ("tenant_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "offline_authority_issuance" ADD CONSTRAINT "offline_authority_issuance_enrollment_fkey"
  FOREIGN KEY ("tenant_id", "branch_id", "enrollment_id")
  REFERENCES "terminal_enrollment" ("tenant_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "offline_authority_issuance" ADD CONSTRAINT "offline_authority_issuance_snapshot_fkey"
  FOREIGN KEY ("tenant_id", "branch_id", "enrollment_id", "snapshot_id")
  REFERENCES "offline_stock_snapshot" ("tenant_id", "branch_id", "enrollment_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- 2. Signed snapshots and the issued pair are historical evidence: never rewritten or removed.
CREATE FUNCTION pc_preserve_offline_authority_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Offline authority evidence (%) is immutable and must be retained', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER preserve_offline_stock_snapshot BEFORE UPDATE OR DELETE ON offline_stock_snapshot
  FOR EACH ROW EXECUTE FUNCTION pc_preserve_offline_authority_evidence();
CREATE TRIGGER preserve_offline_authority_issuance BEFORE UPDATE OR DELETE ON offline_authority_issuance
  FOR EACH ROW EXECUTE FUNCTION pc_preserve_offline_authority_evidence();

-- 3. Staged tenant isolation, like every tenant-owned table (test-rls-policy-inventory.mjs).
CREATE POLICY pc_tenant_isolation ON offline_stock_snapshot
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pc_tenant_isolation ON offline_authority_issuance
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- RLS remains disabled, consistent with the staged inventory.
