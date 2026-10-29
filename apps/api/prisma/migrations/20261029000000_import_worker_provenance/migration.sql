-- P1 #47: initiating authority for the product-import background worker. The worker writes
-- after the starting request has ended, so it revalidates the starting user's live authority
-- (token version, branch assignment, permission) before every write transaction. Existing rows
-- are "legacy": no authority was recorded, so a worker refuses to write for them. Completed
-- imports are unaffected. No stock, product or history is rewritten.

ALTER TABLE "product_import"
  ADD COLUMN "initiated_via" VARCHAR(16) NOT NULL DEFAULT 'legacy',
  ADD COLUMN "initiator_token_version" INTEGER,
  ADD COLUMN "initiator_branch_id" UUID,
  ADD COLUMN "initiator_permission" VARCHAR(80);

ALTER TABLE "product_import" ADD CONSTRAINT "product_import_initiator_shape" CHECK (
  (initiated_via = 'legacy' AND initiator_token_version IS NULL AND initiator_branch_id IS NULL
    AND initiator_permission IS NULL)
  OR (initiated_via = 'request' AND initiator_token_version >= 0 AND initiator_permission IS NOT NULL
    AND (branch_id IS NULL OR initiator_branch_id = branch_id))
);

-- Provenance is evidence of who authorized the writes: never rewritten after insert.
CREATE FUNCTION pc_preserve_product_import_initiator() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.created_by, NEW.initiated_via, NEW.initiator_token_version,
         NEW.initiator_branch_id, NEW.initiator_permission)
     IS DISTINCT FROM ROW(OLD.tenant_id, OLD.created_by, OLD.initiated_via, OLD.initiator_token_version,
         OLD.initiator_branch_id, OLD.initiator_permission) THEN
    RAISE EXCEPTION 'Product import initiator is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_product_import_initiator BEFORE UPDATE ON product_import
  FOR EACH ROW EXECUTE FUNCTION pc_preserve_product_import_initiator();
