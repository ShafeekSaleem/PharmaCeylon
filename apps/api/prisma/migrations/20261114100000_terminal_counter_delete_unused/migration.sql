-- Allow deleting an unused terminal_counter row; see the comment in the function.
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
    IF (to_jsonb(NEW) - 'label' - 'is_active') IS DISTINCT FROM (to_jsonb(OLD) - 'label' - 'is_active') THEN
      RAISE EXCEPTION 'Counter identity is immutable';
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
