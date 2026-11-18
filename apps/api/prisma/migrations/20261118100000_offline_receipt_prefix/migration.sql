-- P4 #50, receipt numbering option A: each till's offline receipts are numbered under its own
-- prefix (C1R, C2R, ...), given on its first offline grant and never reused at the branch.
ALTER TABLE "terminal_counter" ADD COLUMN "offline_receipt_prefix" VARCHAR(8);

ALTER TABLE "terminal_counter" ADD CONSTRAINT "terminal_counter_offline_receipt_prefix_shape"
  CHECK ("offline_receipt_prefix" IS NULL OR "offline_receipt_prefix" ~ '^C[1-9][0-9]{0,3}R$');

-- Postgres treats NULLs as distinct, so tills without a prefix yet don't collide.
CREATE UNIQUE INDEX "terminal_counter_offline_receipt_prefix_key"
  ON "terminal_counter" ("tenant_id", "branch_id", "offline_receipt_prefix");

-- A till's identity stays immutable except its label and active flag, as before, and now its
-- offline receipt prefix: given once (from NULL), never changed or cleared afterwards.
CREATE OR REPLACE FUNCTION pc_preserve_terminal_trust_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- #180: a counter nobody has used may be deleted (a mistake, a duplicate). Every table that
    -- records what happened at a counter holds a RESTRICT foreign key to it, so the delete fails
    -- for a counter with history. Every other table's rows stay undeletable.
    IF TG_TABLE_NAME = 'terminal_counter' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Terminal trust history must be retained';
  END IF;
  IF TG_TABLE_NAME = 'terminal_counter' THEN
    IF (to_jsonb(NEW) - 'label' - 'is_active' - 'offline_receipt_prefix')
         IS DISTINCT FROM (to_jsonb(OLD) - 'label' - 'is_active' - 'offline_receipt_prefix') THEN
      RAISE EXCEPTION 'Counter identity is immutable';
    END IF;
    IF OLD.offline_receipt_prefix IS NOT NULL
       AND NEW.offline_receipt_prefix IS DISTINCT FROM OLD.offline_receipt_prefix THEN
      RAISE EXCEPTION 'A till''s offline receipt prefix never changes';
    END IF;
  ELSIF TG_TABLE_NAME = 'terminal_staff_session' THEN
    IF (to_jsonb(NEW) - 'closed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'closed_at')
       OR (OLD.closed_at IS NOT NULL AND NEW.closed_at IS DISTINCT FROM OLD.closed_at) THEN
      RAISE EXCEPTION 'Staff binding and session closure are immutable';
    END IF;
  ELSE
    IF (to_jsonb(NEW) - 'consumed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'consumed_at')
       OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at) THEN
      RAISE EXCEPTION 'Challenge payload and consumption are immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
