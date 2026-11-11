-- P5 #51, D11 review follow-up. The owner or a delegated manager can close a restored counter's
-- recovery that will never complete (the computer was wiped or restored again), with a reason;
-- and a missing-journal sign-off records the evidence it saw, so evidence that arrives later
-- makes it stale. New columns are nullable: a sign-off made before this has no record of what it
-- saw and is treated as stale.
ALTER TYPE "OfflineJournalRecoveryStatus" ADD VALUE IF NOT EXISTS 'closed';

ALTER TABLE "offline_journal_recovery"
  ADD COLUMN "closed_by_user_id" UUID,
  ADD COLUMN "closed_at" TIMESTAMP(3),
  ADD COLUMN "close_reason" TEXT,
  ADD COLUMN "close_authority" VARCHAR(24),
  ADD COLUMN "close_delegation_id" UUID,
  ADD COLUMN "refusals_seen" INTEGER,
  ADD COLUMN "restores_seen" INTEGER;

-- 'closed' is compared as text: a value added to an enum cannot be used as one in the same
-- transaction.
ALTER TABLE "offline_journal_recovery" ADD CONSTRAINT "offline_journal_recovery_closure" CHECK (
  (("closed_at" IS NULL) = ("closed_by_user_id" IS NULL))
  AND (("closed_at" IS NULL) = ("close_reason" IS NULL))
  AND (("closed_at" IS NULL) = ("close_authority" IS NULL))
  AND ("close_reason" IS NULL OR length(btrim("close_reason")) > 0)
  AND ("close_authority" IS NULL OR "close_authority" IN ('owner', 'delegated_manager'))
  AND (("close_authority" = 'delegated_manager') = ("close_delegation_id" IS NOT NULL))
  AND (("status"::text = 'closed') = ("closed_at" IS NOT NULL))
  AND ("closed_at" IS NULL OR ("kind" = 'counter_restore' AND "closed_at" >= "created_at"))
  AND ("kind" = 'missing_journal' OR ("refusals_seen" IS NULL AND "restores_seen" IS NULL))
  AND ("refusals_seen" IS NULL OR "refusals_seen" >= 0)
  AND ("restores_seen" IS NULL OR "restores_seen" >= 0)
);

-- As before, with closing: an open restore may be closed, and a closed one is finished.
CREATE OR REPLACE FUNCTION pc_offline_journal_recovery_progress() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE progress text[] := ARRAY['status', 'approved_by_user_id', 'approved_at', 'approval_reason',
  'approval_authority', 'approval_delegation_id', 'completed_at', 'completion', 'superseded_at',
  'closed_by_user_id', 'closed_at', 'close_reason', 'close_authority', 'close_delegation_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'offline_journal_recovery rows must be retained'; END IF;
  IF (to_jsonb(NEW) - progress) IS DISTINCT FROM (to_jsonb(OLD) - progress) THEN
    RAISE EXCEPTION 'A journal recovery keeps what was reported or signed off';
  END IF;
  IF OLD.status::text IN ('recovered', 'superseded', 'closed') THEN
    RAISE EXCEPTION 'A finished journal recovery cannot change';
  END IF;
  IF NOT ((OLD.status::text = 'awaiting_approval' AND NEW.status::text IN ('approved', 'superseded', 'closed'))
       OR (OLD.status::text = 'approved' AND NEW.status::text IN ('recovered', 'superseded', 'closed'))) THEN
    RAISE EXCEPTION 'Invalid journal recovery transition % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.approved_at IS NOT NULL AND (NEW.approved_at, NEW.approved_by_user_id, NEW.approval_reason,
      NEW.approval_authority, NEW.approval_delegation_id) IS DISTINCT FROM (OLD.approved_at,
      OLD.approved_by_user_id, OLD.approval_reason, OLD.approval_authority, OLD.approval_delegation_id) THEN
    RAISE EXCEPTION 'A journal recovery approval is final';
  END IF;
  RETURN NEW;
END;
$$;
