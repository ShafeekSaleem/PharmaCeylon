-- AlterTable
ALTER TABLE "purchase_order" ADD COLUMN     "approval_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "metadata_version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "transfer" ADD COLUMN     "approval_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "metadata_version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "goods_return" ADD COLUMN     "approval_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "metadata_version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "management_approval" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "document_type" VARCHAR(40) NOT NULL,
    "document_id" UUID NOT NULL,
    "document_version" INTEGER NOT NULL,
    "document_digest" CHAR(64) NOT NULL,
    "material" JSONB NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "authorized_action" VARCHAR(80) NOT NULL,
    "approved_by_user_id" UUID NOT NULL,
    "approved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "policy_version" INTEGER NOT NULL DEFAULT 1,
    "reason" VARCHAR(500) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revocation_reason" VARCHAR(500),

    CONSTRAINT "management_approval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "management_approval_tenant_id_branch_id_document_type_docum_idx" ON "management_approval"("tenant_id", "branch_id", "document_type", "document_id");

-- AddForeignKey
ALTER TABLE "management_approval" ADD CONSTRAINT "management_approval_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE management_approval ADD CONSTRAINT management_approval_shape CHECK (
  document_version > 0 AND document_digest ~ '^[0-9a-f]{64}$' AND policy_version = 1
  AND jsonb_typeof(material) = 'object' AND length(trim(reason)) > 0
  AND ((document_type = 'purchase_order' AND authorized_action = 'purchase_order.receive')
    OR (document_type = 'transfer' AND authorized_action = 'transfer.ship')
    OR (document_type = 'goods_return' AND authorized_action = 'goods_return.complete'))
  AND (expires_at IS NULL OR expires_at > approved_at)
  AND ((revoked_at IS NULL AND revocation_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL
      AND revoked_at >= approved_at AND length(trim(revocation_reason)) > 0))
);
CREATE FUNCTION pc_preserve_management_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Approval evidence must be retained'; END IF;
  IF (to_jsonb(NEW) - 'revoked_at' - 'revocation_reason') IS DISTINCT FROM
     (to_jsonb(OLD) - 'revoked_at' - 'revocation_reason')
     OR (OLD.revoked_at IS NOT NULL AND ROW(NEW.revoked_at, NEW.revocation_reason)
       IS DISTINCT FROM ROW(OLD.revoked_at, OLD.revocation_reason)) THEN
    RAISE EXCEPTION 'Approval content and revocation history are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_management_approval BEFORE UPDATE OR DELETE ON management_approval
  FOR EACH ROW EXECUTE FUNCTION pc_preserve_management_approval();
CREATE POLICY pc_tenant_isolation ON management_approval
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- RLS remains disabled, consistent with the staged inventory.

-- Notes and ordinary status/progress changes are deliberately separate from approved
-- material. Material edits are captured even through legacy/internal/SQL writers, and
-- changing a value back cannot revive an earlier approval. No approval is backfilled.
CREATE FUNCTION pc_document_approval_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE excluded text[] := ARRAY['approval_version','metadata_version','notes','status','updated_at',
  'created_at','approved_by','received_by','processed_by'];
BEGIN
  IF ROW(NEW.id, NEW.tenant_id) IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id) THEN
    RAISE EXCEPTION 'Document identity cannot be rewritten';
  END IF;
  IF NEW.approval_version < OLD.approval_version OR NEW.approval_version > OLD.approval_version + 1 THEN
    RAISE EXCEPTION 'Approval revision must advance monotonically';
  END IF;
  IF (to_jsonb(NEW) - excluded) IS DISTINCT FROM (to_jsonb(OLD) - excluded) THEN
    NEW.approval_version := OLD.approval_version + 1;
  END IF;
  NEW.metadata_version := OLD.metadata_version + CASE WHEN NEW.notes IS DISTINCT FROM OLD.notes THEN 1 ELSE 0 END;
  RETURN NEW;
END;
$$;
CREATE TRIGGER purchase_order_approval_revision BEFORE UPDATE ON purchase_order
  FOR EACH ROW EXECUTE FUNCTION pc_document_approval_revision();
CREATE TRIGGER transfer_approval_revision BEFORE UPDATE ON transfer
  FOR EACH ROW EXECUTE FUNCTION pc_document_approval_revision();
CREATE TRIGGER goods_return_approval_revision BEFORE UPDATE ON goods_return
  FOR EACH ROW EXECUTE FUNCTION pc_document_approval_revision();
ALTER TABLE purchase_order ADD CONSTRAINT purchase_order_revision_check CHECK (approval_version > 0 AND metadata_version > 0);
ALTER TABLE transfer ADD CONSTRAINT transfer_revision_check CHECK (approval_version > 0 AND metadata_version > 0);
ALTER TABLE goods_return ADD CONSTRAINT goods_return_revision_check CHECK (approval_version > 0 AND metadata_version > 0);

CREATE FUNCTION pc_line_approval_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target jsonb; affected integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.tenant_id, to_jsonb(NEW)->>TG_ARGV[1]) IS DISTINCT FROM
       ROW(OLD.tenant_id, to_jsonb(OLD)->>TG_ARGV[1]) THEN
      RAISE EXCEPTION 'A line cannot move to another document or tenant';
    END IF;
    IF (to_jsonb(NEW) - ARRAY['received_qty','free_qty','rejected_qty','created_at']) IS NOT DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['received_qty','free_qty','rejected_qty','created_at']) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN target := to_jsonb(OLD); ELSE target := to_jsonb(NEW); END IF;
  EXECUTE format('UPDATE %I SET approval_version = approval_version + 1 WHERE tenant_id = $1 AND id = $2', TG_ARGV[0])
    USING (target->>'tenant_id')::uuid, (target->>TG_ARGV[1])::uuid;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 AND TG_OP <> 'DELETE' THEN RAISE EXCEPTION 'Line parent tenant mismatch'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER purchase_order_line_approval_revision AFTER INSERT OR UPDATE OR DELETE ON purchase_order_item
  FOR EACH ROW EXECUTE FUNCTION pc_line_approval_revision('purchase_order', 'purchase_order_id');
CREATE TRIGGER transfer_line_approval_revision AFTER INSERT OR UPDATE OR DELETE ON transfer_item
  FOR EACH ROW EXECUTE FUNCTION pc_line_approval_revision('transfer', 'transfer_id');
CREATE TRIGGER goods_return_line_approval_revision AFTER INSERT OR UPDATE OR DELETE ON goods_return_item
  FOR EACH ROW EXECUTE FUNCTION pc_line_approval_revision('goods_return', 'return_id');
