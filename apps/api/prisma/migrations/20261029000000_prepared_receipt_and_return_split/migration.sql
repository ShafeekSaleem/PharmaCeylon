-- P6: remote prepare/approve of a delivery, posted later at the counter. Approval records exact
-- evidence only; posting goes through the normal receiving path. No existing receipt is rewritten
-- and no historical approval is fabricated.
CREATE TYPE "PreparedReceiptStatus" AS ENUM ('draft', 'approved', 'posted', 'cancelled');

CREATE TABLE "prepared_receipt" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "status" "PreparedReceiptStatus" NOT NULL DEFAULT 'draft',
    "payload" JSONB NOT NULL,
    "notes" VARCHAR(1000),
    "approval_version" INTEGER NOT NULL DEFAULT 1,
    "metadata_version" INTEGER NOT NULL DEFAULT 1,
    "prepared_by" UUID NOT NULL,
    "prepared_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "execution_approval_id" UUID,
    "approved_by" UUID,
    "approved_at" TIMESTAMP(3),
    "executed_by" UUID,
    "executed_at" TIMESTAMP(3),
    "goods_receipt_id" UUID,
    "cancelled_by" UUID,
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" VARCHAR(500),

    CONSTRAINT "prepared_receipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "prepared_receipt_goods_receipt_id_key" ON "prepared_receipt"("goods_receipt_id");
CREATE INDEX "prepared_receipt_tenant_id_branch_id_status_idx" ON "prepared_receipt"("tenant_id", "branch_id", "status");
CREATE INDEX "prepared_receipt_purchase_order_id_status_idx" ON "prepared_receipt"("purchase_order_id", "status");

ALTER TABLE "prepared_receipt" ADD CONSTRAINT "prepared_receipt_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prepared_receipt" ADD CONSTRAINT "prepared_receipt_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prepared_receipt" ADD CONSTRAINT "prepared_receipt_prepared_by_fkey" FOREIGN KEY ("prepared_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prepared_receipt" ADD CONSTRAINT "prepared_receipt_goods_receipt_id_fkey" FOREIGN KEY ("goods_receipt_id") REFERENCES "goods_receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE prepared_receipt ADD CONSTRAINT prepared_receipt_revision_check CHECK (approval_version > 0 AND metadata_version > 0);
ALTER TABLE prepared_receipt ADD CONSTRAINT prepared_receipt_payload_check CHECK (jsonb_typeof(payload) = 'object');
-- One open delivery per order: two would count the same goods twice.
CREATE UNIQUE INDEX prepared_receipt_one_open_per_order ON prepared_receipt (tenant_id, purchase_order_id)
  WHERE status IN ('draft', 'approved');

-- Material edits (even by internal/SQL writers, and changed-then-restored values) advance the
-- approval revision and clear the approval. Notes advance metadata only; status, approval and
-- execution bookkeeping are not material.
CREATE FUNCTION pc_prepared_receipt_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE material_changed boolean; old_json jsonb := to_jsonb(OLD); new_json jsonb := to_jsonb(NEW);
 excluded text[] := ARRAY['approval_version','metadata_version','execution_approval_id','status',
 'approved_by','approved_at','executed_by','executed_at','goods_receipt_id','cancelled_by','cancelled_at',
 'cancel_reason','notes','updated_at'];
BEGIN
 IF ROW(NEW.id, NEW.tenant_id, NEW.branch_id, NEW.purchase_order_id, NEW.prepared_by)
   IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.branch_id, OLD.purchase_order_id, OLD.prepared_by) THEN
  RAISE EXCEPTION 'Prepared receipt identity cannot be rewritten';
 END IF;
 IF NEW.approval_version < OLD.approval_version OR NEW.approval_version > OLD.approval_version + 1 THEN
  RAISE EXCEPTION 'Approval revision must advance monotonically';
 END IF;
 material_changed := (new_json - excluded) IS DISTINCT FROM (old_json - excluded) OR NEW.approval_version > OLD.approval_version;
 IF material_changed THEN
  IF OLD.status::text IN ('posted','cancelled') THEN RAISE EXCEPTION 'Posted or cancelled receipt material is immutable'; END IF;
  NEW.approval_version := OLD.approval_version + 1;
  NEW.execution_approval_id := NULL;
  NEW.approved_by := NULL;
  NEW.approved_at := NULL;
  IF OLD.status::text = 'approved' THEN NEW.status := 'draft'; END IF;
 END IF;
 NEW.metadata_version := OLD.metadata_version + CASE WHEN NEW.notes IS DISTINCT FROM OLD.notes THEN 1 ELSE 0 END;
 RETURN NEW;
END;
$$;
CREATE TRIGGER prepared_receipt_revision BEFORE UPDATE ON prepared_receipt
  FOR EACH ROW EXECUTE FUNCTION pc_prepared_receipt_revision();

-- Staged tenant policy, consistent with the inventory; RLS stays disabled.
CREATE POLICY "pc_tenant_isolation" ON "prepared_receipt"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Exact approval evidence for the new document type. Every earlier pair is kept.
ALTER TABLE management_approval DROP CONSTRAINT management_approval_shape;
ALTER TABLE management_approval ADD CONSTRAINT management_approval_shape CHECK (
  document_version > 0 AND document_digest ~ '^[0-9a-f]{64}$' AND policy_version = 1
  AND jsonb_typeof(material) = 'object' AND length(trim(reason)) > 0
  AND ((document_type = 'purchase_order' AND authorized_action = 'purchase_order.receive')
    OR (document_type = 'transfer' AND authorized_action = 'transfer.ship')
    OR (document_type = 'goods_return' AND authorized_action = 'goods_return.complete')
    OR (document_type = 'stocktake' AND authorized_action = 'stocktake.post')
    OR (document_type = 'held_adjustment' AND authorized_action = 'held_adjustment.post')
    OR (document_type = 'held_delivery' AND authorized_action = 'held_delivery.post')
    OR (document_type = 'prepared_receipt' AND authorized_action = 'prepared_receipt.post'))
  AND (expires_at IS NULL OR expires_at > approved_at)
  AND ((revoked_at IS NULL AND revocation_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL
      AND revoked_at >= approved_at AND length(trim(revocation_reason)) > 0))
);

-- Completing a supplier return is now also a signed counter command (needs `returns.process`).
-- Grant the route gate to every role that can complete a return today, so nobody loses it.
UPDATE "permission" SET "description" =
  'Send signed posting commands (stocktake, write-off, deliveries, import stock, supplier return dispatch) from an enrolled desktop counter. Each command also needs that operation''s own permission.'
WHERE "key" = 'terminal.execute';
INSERT INTO "role_permission" ("id", "tenant_id", "role_id", "permission_key")
SELECT gen_random_uuid(), r."tenant_id", r."id", 'terminal.execute'
FROM "role" r
WHERE EXISTS (
  SELECT 1 FROM "role_permission" rp
  WHERE rp."role_id" = r."id" AND rp."permission_key" = 'returns.process'
)
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
