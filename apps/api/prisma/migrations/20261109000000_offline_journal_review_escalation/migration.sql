-- P5 #51: a retained journal upload's outcome may escalate, never soften.
-- The same content can be refused more than once: held first (a sign-in not uploaded yet, a gap),
-- then judged and rejected, or found to conflict with the accepted chain. Issuance, the counter
-- sync status and the review queue all read `outcome`, so it must say the worst refusal so far:
-- held < rejected < conflict. Everything else about the row still stays as first received.

CREATE OR REPLACE FUNCTION pc_retain_offline_journal_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE counters text[] := ARRAY['attempts', 'last_received_at', 'error_code', 'outcome'];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'offline_journal_review rows must be retained'; END IF;
  IF (to_jsonb(NEW) - counters) IS DISTINCT FROM (to_jsonb(OLD) - counters) THEN
    RAISE EXCEPTION 'A retained journal upload keeps its content';
  END IF;
  IF NEW.outcome IS DISTINCT FROM OLD.outcome AND
     (CASE NEW.outcome WHEN 'held' THEN 1 WHEN 'rejected' THEN 2 WHEN 'conflict' THEN 3 END) <=
     (CASE OLD.outcome WHEN 'held' THEN 1 WHEN 'rejected' THEN 2 WHEN 'conflict' THEN 3 END) THEN
    RAISE EXCEPTION 'A retained journal upload''s outcome only escalates';
  END IF;
  RETURN NEW;
END;
$$;
