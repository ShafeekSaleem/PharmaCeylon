-- Additive revision fields; existing approvals are never fabricated/backfilled.
ALTER TABLE stocktake
  ADD COLUMN approval_version integer NOT NULL DEFAULT 1,
  ADD COLUMN metadata_version integer NOT NULL DEFAULT 1,
  ADD COLUMN execution_approval_id uuid,
  ADD CONSTRAINT stocktake_revision_check CHECK (approval_version > 0 AND metadata_version > 0);
ALTER TABLE management_approval DROP CONSTRAINT management_approval_shape;
ALTER TABLE management_approval ADD CONSTRAINT management_approval_shape CHECK (
  document_version > 0 AND document_digest ~ '^[0-9a-f]{64}$' AND policy_version = 1
  AND jsonb_typeof(material) = 'object' AND length(trim(reason)) > 0
  AND ((document_type = 'purchase_order' AND authorized_action = 'purchase_order.receive')
    OR (document_type = 'transfer' AND authorized_action = 'transfer.ship')
    OR (document_type = 'goods_return' AND authorized_action = 'goods_return.complete')
    OR (document_type = 'stocktake' AND authorized_action = 'stocktake.post'))
  AND (expires_at IS NULL OR expires_at > approved_at)
  AND ((revoked_at IS NULL AND revocation_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL
      AND revoked_at >= approved_at AND length(trim(revocation_reason)) > 0))
);

CREATE FUNCTION pc_stocktake_approval_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE material_changed boolean;
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.branch_id) IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.branch_id) THEN
    RAISE EXCEPTION 'Stocktake identity cannot be rewritten';
  END IF;
  IF NEW.approval_version < OLD.approval_version OR NEW.approval_version > OLD.approval_version + 1
     OR NEW.metadata_version < OLD.metadata_version OR NEW.metadata_version > OLD.metadata_version + 1 THEN
    RAISE EXCEPTION 'Stocktake revisions must advance monotonically';
  END IF;
  material_changed := ROW(NEW.scope, NEW.movement_mode, NEW.snapshot_at, NEW.frozen_at, NEW.counted_by)
    IS DISTINCT FROM ROW(OLD.scope, OLD.movement_mode, OLD.snapshot_at, OLD.frozen_at, OLD.counted_by)
    OR NEW.approval_version > OLD.approval_version;
  IF material_changed THEN
    IF OLD.status IN ('posted', 'completed') THEN
      RAISE EXCEPTION 'Posted stocktake material is immutable';
    END IF;
    NEW.approval_version := OLD.approval_version + 1;
    NEW.execution_approval_id := NULL;
    IF OLD.status = 'approved' THEN NEW.status := 'under_review'; END IF;
  END IF;
  NEW.metadata_version := OLD.metadata_version + CASE WHEN
    ROW(NEW.notes, NEW.title, NEW.area_label) IS DISTINCT FROM ROW(OLD.notes, OLD.title, OLD.area_label)
    OR NEW.metadata_version > OLD.metadata_version THEN 1 ELSE 0 END;
  RETURN NEW;
END;
$$;
CREATE TRIGGER stocktake_approval_revision BEFORE UPDATE ON stocktake
  FOR EACH ROW EXECUTE FUNCTION pc_stocktake_approval_revision();

-- Parent revision writes acquire its lock before approval can inspect child material.
-- Posting-only status/variance/stamps and nonmaterial notes do not invalidate evidence.
CREATE FUNCTION pc_stocktake_child_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target jsonb; changed boolean := true; metadata_changed boolean := false; affected integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.tenant_id, NEW.stocktake_id) IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.stocktake_id) THEN
      RAISE EXCEPTION 'Stocktake evidence identity cannot be rewritten';
    END IF;
    IF TG_TABLE_NAME = 'stocktake_line' THEN
      changed := (to_jsonb(NEW) - ARRAY['note','review_note','reviewed_by','reviewed_at','approved_by','approved_at','posted_at','variance_qty','status'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['note','review_note','reviewed_by','reviewed_at','approved_by','approved_at','posted_at','variance_qty','status'])
        OR (NEW.status = 'recount_requested') IS DISTINCT FROM (OLD.status = 'recount_requested');
      metadata_changed := ROW(NEW.note, NEW.review_note) IS DISTINCT FROM ROW(OLD.note, OLD.review_note);
    ELSIF TG_TABLE_NAME = 'stocktake_count_entry' THEN
      changed := (to_jsonb(NEW) - 'note') IS DISTINCT FROM (to_jsonb(OLD) - 'note');
      metadata_changed := NEW.note IS DISTINCT FROM OLD.note;
    ELSE
      changed := to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD);
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN target := to_jsonb(OLD); ELSE target := to_jsonb(NEW); END IF;
  IF changed OR metadata_changed THEN
    UPDATE stocktake SET approval_version = approval_version + CASE WHEN changed THEN 1 ELSE 0 END,
      metadata_version = metadata_version + CASE WHEN metadata_changed THEN 1 ELSE 0 END
      WHERE tenant_id = (target->>'tenant_id')::uuid AND id = (target->>'stocktake_id')::uuid;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 AND TG_OP <> 'DELETE' THEN RAISE EXCEPTION 'Stocktake parent tenant mismatch'; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER stocktake_line_approval_revision BEFORE INSERT OR UPDATE OR DELETE ON stocktake_line
  FOR EACH ROW EXECUTE FUNCTION pc_stocktake_child_revision();
CREATE TRIGGER stocktake_snapshot_approval_revision BEFORE INSERT OR UPDATE OR DELETE ON stocktake_snapshot_line
  FOR EACH ROW EXECUTE FUNCTION pc_stocktake_child_revision();
CREATE TRIGGER stocktake_count_approval_revision BEFORE INSERT OR UPDATE OR DELETE ON stocktake_count_entry
  FOR EACH ROW EXECUTE FUNCTION pc_stocktake_child_revision();
