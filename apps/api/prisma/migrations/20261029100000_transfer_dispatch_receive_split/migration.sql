-- P6: approval (reservation only) is distinct from dispatch at the source counter and receipt at
-- the destination counter. Dispatch pins the exact approval; no historical approval is backfilled.
ALTER TABLE transfer ADD COLUMN execution_approval_id uuid,
  ADD COLUMN approved_at timestamp(3),
  ADD COLUMN dispatched_by uuid,
  ADD COLUMN dispatched_at timestamp(3),
  ADD COLUMN received_at timestamp(3);

-- Transfer-only revision rule: the shared document rule plus the execution bookkeeping above,
-- which is approval/progress state, not approved material.
CREATE FUNCTION pc_transfer_approval_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE excluded text[] := ARRAY['approval_version','metadata_version','notes','status','updated_at',
  'created_at','approved_by','received_by','execution_approval_id','approved_at','dispatched_by',
  'dispatched_at','received_at'];
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
DROP TRIGGER transfer_approval_revision ON transfer;
CREATE TRIGGER transfer_approval_revision BEFORE UPDATE ON transfer
  FOR EACH ROW EXECUTE FUNCTION pc_transfer_approval_revision();

-- A dispatched transfer records who dispatched it and when, together.
ALTER TABLE transfer ADD CONSTRAINT transfer_dispatch_shape CHECK (
  (dispatched_by IS NULL) = (dispatched_at IS NULL)
);
