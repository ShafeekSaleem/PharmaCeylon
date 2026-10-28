ALTER TABLE product_import
  ADD COLUMN stock_staged boolean NOT NULL DEFAULT false,
  ADD COLUMN stock_version integer NOT NULL DEFAULT 1,
  ADD COLUMN stock_staged_by uuid,
  ADD COLUMN staged_stock jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN stock_posted_at timestamp(3),
  ADD COLUMN stock_posted_by uuid;

ALTER TABLE product_import ADD CONSTRAINT product_import_stock_version_positive CHECK (stock_version > 0);
ALTER TABLE product_import ADD CONSTRAINT product_import_staged_stock_array CHECK (jsonb_typeof(staged_stock) = 'array');
ALTER TABLE product_import ADD CONSTRAINT product_import_post_actor CHECK ((stock_posted_at IS NULL) = (stock_posted_by IS NULL));

-- Material edits, including internal writers and change-then-revert edits, invalidate
-- the displayed version. Posting evidence does not restate the saved draft material.
CREATE FUNCTION product_import_stock_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_material jsonb; new_material jsonb;
BEGIN
  IF NEW.stock_staged IS DISTINCT FROM OLD.stock_staged OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.branch_id IS DISTINCT FROM OLD.branch_id OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'Import staging identity is immutable';
  END IF;
  SELECT COALESCE(jsonb_agg(value - 'postedBatchId' ORDER BY ordinality), '[]') INTO old_material
    FROM jsonb_array_elements(OLD.staged_stock) WITH ORDINALITY;
  SELECT COALESCE(jsonb_agg(value - 'postedBatchId' ORDER BY ordinality), '[]') INTO new_material
    FROM jsonb_array_elements(NEW.staged_stock) WITH ORDINALITY;
  IF old_material IS DISTINCT FROM new_material THEN
    IF OLD.stock_posted_at IS NOT NULL THEN RAISE EXCEPTION 'Posted stock material is immutable'; END IF;
    NEW.stock_version := OLD.stock_version + 1;
  ELSE
    NEW.stock_version := OLD.stock_version;
  END IF;
  IF OLD.stock_posted_at IS NOT NULL AND (NEW.stock_staged_by IS DISTINCT FROM OLD.stock_staged_by OR NEW.stock_posted_at IS DISTINCT FROM OLD.stock_posted_at
    OR NEW.stock_posted_by IS DISTINCT FROM OLD.stock_posted_by) THEN
    RAISE EXCEPTION 'Original stock posting identity is immutable';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(OLD.staged_stock) old_row
      WHERE old_row->>'postedBatchId' IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW.staged_stock) new_row
        WHERE new_row->>'rowNumber' = old_row->>'rowNumber'
          AND new_row->>'postedBatchId' = old_row->>'postedBatchId')) THEN
    RAISE EXCEPTION 'Posted stock row identity is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER product_import_stock_revision BEFORE UPDATE ON product_import
  FOR EACH ROW EXECUTE FUNCTION product_import_stock_revision();
