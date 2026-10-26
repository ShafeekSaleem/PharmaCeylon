-- Approval is distinct from the existing accepted (posted) state.
ALTER TYPE "HeldAdjustmentStatus" ADD VALUE 'approved';
ALTER TYPE "HeldDeliveryStatus" ADD VALUE 'approved';
ALTER TABLE held_adjustment ADD COLUMN approval_version integer NOT NULL DEFAULT 1,
 ADD COLUMN metadata_version integer NOT NULL DEFAULT 1, ADD COLUMN execution_approval_id uuid,
 ADD COLUMN executed_by uuid, ADD COLUMN executed_at timestamp(3);
ALTER TABLE held_delivery ADD COLUMN approval_version integer NOT NULL DEFAULT 1,
 ADD COLUMN metadata_version integer NOT NULL DEFAULT 1, ADD COLUMN execution_approval_id uuid,
 ADD COLUMN executed_by uuid, ADD COLUMN executed_at timestamp(3), ADD COLUMN prepared_payload jsonb;
-- No historical approval or executor attribution is fabricated.
ALTER TABLE management_approval DROP CONSTRAINT management_approval_shape;
ALTER TABLE management_approval ADD CONSTRAINT management_approval_shape CHECK (
  document_version > 0 AND document_digest ~ '^[0-9a-f]{64}$' AND policy_version = 1
  AND jsonb_typeof(material) = 'object' AND length(trim(reason)) > 0
  AND ((document_type = 'purchase_order' AND authorized_action = 'purchase_order.receive')
    OR (document_type = 'transfer' AND authorized_action = 'transfer.ship')
    OR (document_type = 'goods_return' AND authorized_action = 'goods_return.complete')
    OR (document_type = 'stocktake' AND authorized_action = 'stocktake.post')
    OR (document_type = 'held_adjustment' AND authorized_action = 'held_adjustment.post')
    OR (document_type = 'held_delivery' AND authorized_action = 'held_delivery.post'))
  AND (expires_at IS NULL OR expires_at > approved_at)
  AND ((revoked_at IS NULL AND revocation_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL
      AND revoked_at >= approved_at AND length(trim(revocation_reason)) > 0))
);


CREATE FUNCTION pc_held_approval_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE material_changed boolean; old_json jsonb := to_jsonb(OLD); new_json jsonb := to_jsonb(NEW);
 excluded text[] := ARRAY['approval_version','metadata_version','execution_approval_id','executed_by','executed_at',
 'status','decided_by','decided_at','decision_note','requested_at','corrected','reference_id','goods_receipt_id','note','detail'];
BEGIN
 IF ROW(NEW.id, NEW.tenant_id, NEW.branch_id, NEW.requested_by) IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.branch_id, OLD.requested_by)
   OR (new_json->>'purchase_order_id') IS DISTINCT FROM (old_json->>'purchase_order_id') THEN
  RAISE EXCEPTION 'Held request identity cannot be rewritten';
 END IF;
 IF NEW.approval_version < OLD.approval_version OR NEW.approval_version > OLD.approval_version + 1 THEN
  RAISE EXCEPTION 'Approval revision must advance monotonically';
 END IF;
 material_changed := (new_json - excluded) IS DISTINCT FROM (old_json - excluded) OR NEW.approval_version > OLD.approval_version;
 IF material_changed THEN
  IF OLD.status::text IN ('accepted','rejected') THEN RAISE EXCEPTION 'Completed held material is immutable'; END IF;
  NEW.approval_version := OLD.approval_version + 1;
  NEW.execution_approval_id := NULL;
  IF OLD.status::text = 'approved' THEN NEW.status := 'awaiting_approval'; END IF;
 END IF;
 NEW.metadata_version := OLD.metadata_version + CASE WHEN
  (new_json->'note') IS DISTINCT FROM (old_json->'note') OR (new_json->'detail') IS DISTINCT FROM (old_json->'detail') THEN 1 ELSE 0 END;
 RETURN NEW;
END;
$$;
CREATE TRIGGER held_adjustment_revision BEFORE UPDATE ON held_adjustment FOR EACH ROW EXECUTE FUNCTION pc_held_approval_revision();
CREATE TRIGGER held_delivery_revision BEFORE UPDATE ON held_delivery FOR EACH ROW EXECUTE FUNCTION pc_held_approval_revision();
ALTER TABLE held_adjustment ADD CONSTRAINT held_adjustment_revision_check CHECK (approval_version > 0 AND metadata_version > 0);
ALTER TABLE held_delivery ADD CONSTRAINT held_delivery_revision_check CHECK (approval_version > 0 AND metadata_version > 0);
