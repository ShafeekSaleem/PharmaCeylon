CREATE UNIQUE INDEX supplier_tenant_id_id_key ON supplier(tenant_id, id);
CREATE UNIQUE INDEX supplier_payment_tenant_id_id_key ON supplier_payment(tenant_id, id);
CREATE TABLE supplier_payment_evidence (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  uploaded_by uuid NOT NULL,
  payment_material jsonb NOT NULL,
  material_digest varchar(64) NOT NULL,
  invoice_digest varchar(64) NOT NULL,
  content_digest varchar(64) NOT NULL,
  media_type varchar(64) NOT NULL,
  content bytea NOT NULL,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  consumed_payment_id uuid,
  consumed_at timestamp(3),
  revoked_at timestamp(3),
  revoked_by uuid,
  revocation_reason varchar(500),
  CONSTRAINT supplier_payment_evidence_tenant_id_fkey FOREIGN KEY(tenant_id) REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT supplier_payment_evidence_tenant_id_branch_id_fkey FOREIGN KEY(tenant_id, branch_id) REFERENCES branch(tenant_id, id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT supplier_payment_evidence_tenant_id_supplier_id_fkey FOREIGN KEY(tenant_id, supplier_id) REFERENCES supplier(tenant_id, id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT supplier_payment_evidence_uploaded_by_fkey FOREIGN KEY(uploaded_by) REFERENCES app_user(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT supplier_payment_evidence_tenant_id_consumed_payment_id_fkey FOREIGN KEY(tenant_id, consumed_payment_id) REFERENCES supplier_payment(tenant_id, id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT supplier_payment_evidence_shape CHECK (
    material_digest ~ '^[0-9a-f]{64}$' AND invoice_digest ~ '^[0-9a-f]{64}$' AND content_digest ~ '^[0-9a-f]{64}$'
    AND octet_length(content) BETWEEN 1 AND 5242880
    AND media_type IN ('application/pdf','image/jpeg','image/png','image/webp')
    AND jsonb_typeof(payment_material) = 'object'
    AND payment_material ?& ARRAY['supplierId','paidOn','amount','method','reference','notes','allocations']
    AND jsonb_typeof(payment_material->'supplierId') = 'string'
    AND payment_material->>'supplierId' = supplier_id::text
    AND jsonb_typeof(payment_material->'method') = 'string'
    AND payment_material->>'method' IN ('bank_transfer','cheque','card')
    AND ((consumed_at IS NULL AND consumed_payment_id IS NULL) OR (consumed_at IS NOT NULL AND consumed_payment_id IS NOT NULL AND consumed_at >= created_at))
    AND ((revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL) OR
      (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revocation_reason IS NOT NULL AND length(trim(revocation_reason)) > 0 AND revoked_at >= created_at))
    AND NOT (revoked_at IS NOT NULL AND consumed_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX supplier_payment_evidence_tenant_id_id_key ON supplier_payment_evidence(tenant_id,id);
CREATE UNIQUE INDEX supplier_payment_evidence_active_content_key ON supplier_payment_evidence(tenant_id,content_digest) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX supplier_payment_evidence_consumed_payment_id_key ON supplier_payment_evidence(consumed_payment_id);
CREATE UNIQUE INDEX supplier_payment_evidence_tenant_id_consumed_payment_id_key ON supplier_payment_evidence(tenant_id,consumed_payment_id);
CREATE INDEX supplier_payment_evidence_tenant_id_branch_id_created_at_idx ON supplier_payment_evidence(tenant_id,branch_id,created_at);
CREATE FUNCTION pc_supplier_payment_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Payment evidence history cannot be deleted'; END IF;
  IF (to_jsonb(NEW) - ARRAY['consumed_payment_id','consumed_at','revoked_at','revoked_by','revocation_reason'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['consumed_payment_id','consumed_at','revoked_at','revoked_by','revocation_reason']) THEN
    RAISE EXCEPTION 'Payment evidence material is immutable';
  END IF;
  IF OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Finished payment evidence is immutable'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_payment_evidence_immutable BEFORE UPDATE OR DELETE ON supplier_payment_evidence
  FOR EACH ROW EXECUTE FUNCTION pc_supplier_payment_evidence_immutable();
CREATE POLICY pc_tenant_isolation ON supplier_payment_evidence
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- RLS remains staged/disabled, consistently with the existing tenant policy inventory.
