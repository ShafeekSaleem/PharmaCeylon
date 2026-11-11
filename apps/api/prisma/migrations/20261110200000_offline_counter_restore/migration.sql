-- P5 #51, store backup and restore (decisions of 2026-11-10). A counter that restored its
-- encrypted store from one of its own backups reports it, device-signed; it gets no offline
-- authority until the owner or a delegated manager (revised D13) acknowledges the restore. New
-- table only, plus one more reason a late offline sale's batch can wait on its case.
CREATE TYPE "OfflineCounterRestoreStatus" AS ENUM ('awaiting_acknowledgement', 'acknowledged');

CREATE TABLE "offline_counter_restore" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "terminal_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "key_id" VARCHAR(128) NOT NULL,
    "restore_id" UUID NOT NULL,
    "status" "OfflineCounterRestoreStatus" NOT NULL,
    "envelope" JSONB NOT NULL,
    "backup_id" VARCHAR(64) NOT NULL,
    "backup_taken_at" TIMESTAMP(3) NOT NULL,
    "restored_at" TIMESTAMP(3) NOT NULL,
    "journal_head_sequence" BIGINT NOT NULL,
    "journal_head_hash" CHAR(64),
    "accepted_sequence" BIGINT NOT NULL,
    "accepted_hash" CHAR(64),
    "outage_active" BOOLEAN NOT NULL,
    "removed_grant_version" INTEGER,
    "server_head_sequence" BIGINT NOT NULL,
    "server_head_hash" CHAR(64),
    "latest_grant_version" INTEGER NOT NULL,
    "last_contact_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" UUID NOT NULL,
    "acknowledged_by_user_id" UUID,
    "acknowledged_at" TIMESTAMP(3),
    "acknowledgement_reason" TEXT,
    "acknowledgement_authority" VARCHAR(24),
    "acknowledgement_delegation_id" UUID,
    CONSTRAINT "offline_counter_restore_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "offline_counter_restore_shape" CHECK (
      jsonb_typeof("envelope") = 'object'
      AND length("backup_id") > 0
      AND "backup_taken_at" <= "restored_at"
      AND "journal_head_sequence" >= 0 AND "accepted_sequence" >= 0 AND "server_head_sequence" >= 0
      AND "accepted_sequence" <= "journal_head_sequence"
      AND (("journal_head_sequence" = 0) = ("journal_head_hash" IS NULL))
      AND (("accepted_sequence" = 0) = ("accepted_hash" IS NULL))
      AND (("server_head_sequence" = 0) = ("server_head_hash" IS NULL))
      AND ("journal_head_hash" IS NULL OR "journal_head_hash" ~ '^[0-9a-f]{64}$')
      AND ("accepted_hash" IS NULL OR "accepted_hash" ~ '^[0-9a-f]{64}$')
      AND ("server_head_hash" IS NULL OR "server_head_hash" ~ '^[0-9a-f]{64}$')
      AND ("removed_grant_version" IS NULL OR "removed_grant_version" >= 1)
      AND "latest_grant_version" >= 0
      -- An acknowledgement is whole or absent, by an owner or a delegated manager, with a reason.
      AND (("status" = 'acknowledged') = ("acknowledged_at" IS NOT NULL))
      AND (("acknowledged_at" IS NULL) = ("acknowledged_by_user_id" IS NULL))
      AND (("acknowledged_at" IS NULL) = ("acknowledgement_reason" IS NULL))
      AND (("acknowledged_at" IS NULL) = ("acknowledgement_authority" IS NULL))
      AND ("acknowledgement_reason" IS NULL OR length(btrim("acknowledgement_reason")) > 0)
      AND ("acknowledgement_authority" IS NULL OR "acknowledgement_authority" IN ('owner', 'delegated_manager'))
      AND (("acknowledgement_authority" = 'delegated_manager') = ("acknowledgement_delegation_id" IS NOT NULL))
      AND ("acknowledged_at" IS NULL OR "acknowledged_at" >= "created_at")
    )
);

CREATE UNIQUE INDEX "offline_counter_restore_tenant_id_branch_id_id_key" ON "offline_counter_restore"("tenant_id", "branch_id", "id");
CREATE UNIQUE INDEX "offline_counter_restore_tenant_id_enrollment_id_restore_id_key" ON "offline_counter_restore"("tenant_id", "enrollment_id", "restore_id");
CREATE INDEX "offline_counter_restore_tenant_id_branch_id_status_idx" ON "offline_counter_restore"("tenant_id", "branch_id", "status");
CREATE INDEX "offline_counter_restore_tenant_id_enrollment_id_status_idx" ON "offline_counter_restore"("tenant_id", "enrollment_id", "status");

ALTER TABLE "offline_counter_restore" ADD CONSTRAINT "offline_counter_restore_enrollment_fkey" FOREIGN KEY ("tenant_id", "branch_id", "terminal_id", "enrollment_id", "key_id") REFERENCES "terminal_enrollment"("tenant_id", "branch_id", "terminal_id", "id", "key_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- What the counter reported and what the server held never change, and the row is kept; the
-- status moves once, awaiting_acknowledgement -> acknowledged, with its acknowledgement.
CREATE FUNCTION pc_offline_counter_restore_progress() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE progress text[] := ARRAY['status', 'acknowledged_by_user_id', 'acknowledged_at',
  'acknowledgement_reason', 'acknowledgement_authority', 'acknowledgement_delegation_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'offline_counter_restore rows must be retained'; END IF;
  IF (to_jsonb(NEW) - progress) IS DISTINCT FROM (to_jsonb(OLD) - progress) THEN
    RAISE EXCEPTION 'A counter restore keeps what was reported';
  END IF;
  IF NOT (OLD.status = 'awaiting_acknowledgement' AND NEW.status = 'acknowledged') THEN
    RAISE EXCEPTION 'Invalid counter restore transition % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER offline_counter_restore_progress BEFORE UPDATE OR DELETE ON "offline_counter_restore"
  FOR EACH ROW EXECUTE FUNCTION pc_offline_counter_restore_progress();

CREATE POLICY pc_tenant_isolation ON offline_counter_restore
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- RLS remains disabled, consistent with the staged inventory.

-- A late offline sale's batch that a posted count settled after the sale was made waits on its
-- case as `counted_after_sale`: that count already took the units off, so posting them would
-- deduct them twice. `entry_reviewed` is kept for the journal settlement slice (20261110100000),
-- whichever of the two lands first. Added NOT VALID and validated by the next migration.
ALTER TABLE offline_stock_discrepancy_line DROP CONSTRAINT offline_stock_discrepancy_line_shape;
ALTER TABLE offline_stock_discrepancy_line ADD CONSTRAINT offline_stock_discrepancy_line_shape CHECK (
  "sold_quantity" > 0 AND "available_quantity_at_sync" >= 0
  AND "shortfall_quantity" = GREATEST("sold_quantity" - "available_quantity_at_sync", 0)
  AND "reason" IN ('shortfall', 'batch_under_review', 'sale_pending', 'entry_reviewed', 'counted_after_sale')
  AND (("reason" = 'shortfall') = ("shortfall_quantity" > 0))
) NOT VALID;
