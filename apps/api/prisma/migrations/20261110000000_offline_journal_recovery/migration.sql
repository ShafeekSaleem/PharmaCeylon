-- P5 #51, approved D11 (decisions of 2026-11-10): journal recovery for a restored counter and the
-- missing-journal sign-off that lets another counter take over offline selling. New tables only;
-- nothing existing changes shape.
CREATE TYPE "OfflineJournalRecoveryKind" AS ENUM ('counter_restore', 'missing_journal');
CREATE TYPE "OfflineJournalRecoveryStatus" AS ENUM ('awaiting_approval', 'approved', 'recovered', 'superseded');

CREATE TABLE "offline_journal_recovery" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "terminal_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "key_id" VARCHAR(128) NOT NULL,
    "kind" "OfflineJournalRecoveryKind" NOT NULL,
    "status" "OfflineJournalRecoveryStatus" NOT NULL,
    "server_head_sequence" BIGINT NOT NULL,
    "server_head_hash" CHAR(64),
    "report_id" UUID,
    "report" JSONB,
    "local_head_sequence" BIGINT,
    "local_head_hash" CHAR(64),
    "common_sequence" BIGINT,
    "common_hash" CHAR(64),
    "nomination_version" INTEGER,
    "cutoff" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" UUID NOT NULL,
    "approved_by_user_id" UUID,
    "approved_at" TIMESTAMP(3),
    "approval_reason" TEXT,
    "approval_authority" VARCHAR(24),
    "approval_delegation_id" UUID,
    "completed_at" TIMESTAMP(3),
    "completion" JSONB,
    "superseded_at" TIMESTAMP(3),
    CONSTRAINT "offline_journal_recovery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "offline_journal_recovery_shape" CHECK (
      "server_head_sequence" >= 0
      AND (("server_head_sequence" = 0) = ("server_head_hash" IS NULL))
      AND ("server_head_hash" IS NULL OR "server_head_hash" ~ '^[0-9a-f]{64}$')
      AND (
        ("kind" = 'counter_restore'
          AND "report_id" IS NOT NULL AND "report" IS NOT NULL
          AND "local_head_sequence" >= 0 AND "common_sequence" >= 0
          AND (("local_head_sequence" = 0) = ("local_head_hash" IS NULL))
          AND (("common_sequence" = 0) = ("common_hash" IS NULL))
          AND "common_sequence" <= "server_head_sequence" AND "common_sequence" <= "local_head_sequence"
          AND "nomination_version" IS NULL AND "cutoff" IS NULL)
        OR
        ("kind" = 'missing_journal'
          AND "report_id" IS NULL AND "report" IS NULL
          AND "local_head_sequence" IS NULL AND "local_head_hash" IS NULL
          AND "common_sequence" IS NULL AND "common_hash" IS NULL
          AND "nomination_version" >= 1 AND jsonb_typeof("cutoff") = 'object'
          AND "status" IN ('approved', 'superseded') AND "completed_at" IS NULL)
      )
      -- An approval is whole or absent, by an owner or a delegated manager, with a reason.
      AND (("approved_by_user_id" IS NULL) = ("approved_at" IS NULL))
      AND (("approved_at" IS NULL) = ("approval_reason" IS NULL))
      AND (("approved_at" IS NULL) = ("approval_authority" IS NULL))
      AND ("approval_reason" IS NULL OR length(btrim("approval_reason")) > 0)
      AND ("approval_authority" IS NULL OR "approval_authority" IN ('owner', 'delegated_manager'))
      AND (("approval_authority" = 'delegated_manager') = ("approval_delegation_id" IS NOT NULL))
      AND ("approved_at" IS NULL OR "approved_at" >= "created_at")
      AND (("status" = 'awaiting_approval') <= ("approved_at" IS NULL))
      AND (("status" IN ('approved', 'recovered')) <= ("approved_at" IS NOT NULL))
      AND (("status" = 'recovered') = ("completed_at" IS NOT NULL))
      AND (("completed_at" IS NULL) = ("completion" IS NULL))
      AND (("status" = 'superseded') = ("superseded_at" IS NOT NULL))
    )
);

CREATE TABLE "offline_journal_recovery_entry" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "recovery_id" UUID NOT NULL,
    "record_kind" VARCHAR(16) NOT NULL,
    "record_id" UUID NOT NULL,
    "sequence" BIGINT,
    "record_hash" CHAR(64) NOT NULL,
    "envelope" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "offline_journal_recovery_entry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "offline_journal_recovery_entry_shape" CHECK (
      "record_kind" IN ('command', 'staff_sign_in')
      AND "record_hash" ~ '^[0-9a-f]{64}$'
      AND (("record_kind" = 'command') = ("sequence" IS NOT NULL))
      AND ("sequence" IS NULL OR "sequence" >= 1)
    )
);

CREATE UNIQUE INDEX "offline_journal_recovery_tenant_id_branch_id_id_key" ON "offline_journal_recovery"("tenant_id", "branch_id", "id");
CREATE UNIQUE INDEX "offline_journal_recovery_tenant_id_enrollment_id_report_id_key" ON "offline_journal_recovery"("tenant_id", "enrollment_id", "report_id");
CREATE INDEX "offline_journal_recovery_tenant_id_branch_id_status_idx" ON "offline_journal_recovery"("tenant_id", "branch_id", "status");
CREATE INDEX "offline_journal_recovery_tenant_id_enrollment_id_kind_status_idx" ON "offline_journal_recovery"("tenant_id", "enrollment_id", "kind", "status");
-- At most one open recovery and one live sign-off per counter enrollment.
CREATE UNIQUE INDEX "offline_journal_recovery_open_key" ON "offline_journal_recovery"("tenant_id", "enrollment_id", "kind")
  WHERE "status" IN ('awaiting_approval', 'approved');
CREATE UNIQUE INDEX "offline_journal_recovery_entry_recovery_id_record_kind_record_hash_key" ON "offline_journal_recovery_entry"("recovery_id", "record_kind", "record_hash");
CREATE INDEX "offline_journal_recovery_entry_tenant_id_recovery_id_idx" ON "offline_journal_recovery_entry"("tenant_id", "recovery_id");

ALTER TABLE "offline_journal_recovery" ADD CONSTRAINT "offline_journal_recovery_enrollment_fkey" FOREIGN KEY ("tenant_id", "branch_id", "terminal_id", "enrollment_id", "key_id") REFERENCES "terminal_enrollment"("tenant_id", "branch_id", "terminal_id", "id", "key_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "offline_journal_recovery_entry" ADD CONSTRAINT "offline_journal_recovery_entry_recovery_fkey" FOREIGN KEY ("tenant_id", "branch_id", "recovery_id") REFERENCES "offline_journal_recovery"("tenant_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- What was reported or signed off never changes; only the status moves forward, once, along
-- awaiting_approval -> approved -> recovered, or to superseded from an open state.
CREATE FUNCTION pc_offline_journal_recovery_progress() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE progress text[] := ARRAY['status', 'approved_by_user_id', 'approved_at', 'approval_reason',
  'approval_authority', 'approval_delegation_id', 'completed_at', 'completion', 'superseded_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'offline_journal_recovery rows must be retained'; END IF;
  IF (to_jsonb(NEW) - progress) IS DISTINCT FROM (to_jsonb(OLD) - progress) THEN
    RAISE EXCEPTION 'A journal recovery keeps what was reported or signed off';
  END IF;
  IF OLD.status IN ('recovered', 'superseded') THEN
    RAISE EXCEPTION 'A finished journal recovery cannot change';
  END IF;
  IF NOT ((OLD.status = 'awaiting_approval' AND NEW.status IN ('approved', 'superseded'))
       OR (OLD.status = 'approved' AND NEW.status IN ('recovered', 'superseded'))) THEN
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
CREATE TRIGGER offline_journal_recovery_progress BEFORE UPDATE OR DELETE ON "offline_journal_recovery"
  FOR EACH ROW EXECUTE FUNCTION pc_offline_journal_recovery_progress();
-- The evidence is append-only (pc_immutable_offline_evidence from slice 1).
CREATE TRIGGER retain_offline_journal_recovery_entry BEFORE UPDATE OR DELETE ON "offline_journal_recovery_entry"
  FOR EACH ROW EXECUTE FUNCTION pc_immutable_offline_evidence();

CREATE POLICY pc_tenant_isolation ON offline_journal_recovery
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pc_tenant_isolation ON offline_journal_recovery_entry
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- RLS remains disabled, consistent with the staged inventory.
