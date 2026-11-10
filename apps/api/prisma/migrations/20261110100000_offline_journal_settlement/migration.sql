-- P5 #51 slice 4: a manager settles an offline journal entry the server rejected, so the counter
-- that sent it can finish synchronising. The decision is prepared, exactly approved (the existing
-- management_approval machinery, new offline_journal_settlement pair) and written on approval in
-- one transaction: the terminal_command_receipt at the entry's own sequence and digest, and for
-- `recorded` the sale (always pending an offline stock case, so no stock moves remotely) or the
-- replayed shift. `not_honoured` writes no sale, payment or stock.

CREATE TYPE "OfflineJournalSettlementDecision" AS ENUM ('recorded', 'not_honoured');
CREATE TYPE "OfflineJournalSettlementStatus" AS ENUM ('prepared', 'settled', 'cancelled');

-- The settlement points at the retained refusal by tenant, branch and id.
CREATE UNIQUE INDEX "offline_journal_review_tenant_branch_id_key" ON "offline_journal_review"("tenant_id", "branch_id", "id");

CREATE TABLE "offline_journal_settlement" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "review_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "command_id" UUID NOT NULL,
    "sequence" BIGINT NOT NULL,
    "record_hash" CHAR(64) NOT NULL,
    "decision" "OfflineJournalSettlementDecision" NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "status" "OfflineJournalSettlementStatus" NOT NULL DEFAULT 'prepared',
    "approval_version" INTEGER NOT NULL DEFAULT 1,
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "execution_approval_id" UUID,
    "approved_by" UUID,
    "settled_at" TIMESTAMP(3),
    "result" JSONB,
    "cancelled_by" UUID,
    "cancelled_at" TIMESTAMP(3),

    CONSTRAINT "offline_journal_settlement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "offline_journal_settlement_shape" CHECK (
      "sequence" > 0 AND "record_hash" ~ '^[0-9a-f]{64}$'
      AND length(btrim("reason")) > 0
      AND "approval_version" = 1
      AND (("status" = 'settled') = ("execution_approval_id" IS NOT NULL AND "approved_by" IS NOT NULL
        AND "settled_at" IS NOT NULL AND "result" IS NOT NULL))
      AND (("status" = 'cancelled') = ("cancelled_by" IS NOT NULL AND "cancelled_at" IS NOT NULL))
    )
);
CREATE INDEX "offline_journal_settlement_tenant_id_branch_id_status_idx" ON "offline_journal_settlement"("tenant_id", "branch_id", "status");
CREATE INDEX "offline_journal_settlement_review_id_idx" ON "offline_journal_settlement"("review_id");
-- One decision at a time per refused entry, and an entry is settled once.
CREATE UNIQUE INDEX "offline_journal_settlement_one_open_per_review" ON "offline_journal_settlement"("review_id")
  WHERE "status" = 'prepared';
CREATE UNIQUE INDEX "offline_journal_settlement_one_settled_per_review" ON "offline_journal_settlement"("review_id")
  WHERE "status" = 'settled';
-- A sequence of an enrollment's journal is settled at most once (its receipt is unique too).
CREATE UNIQUE INDEX "offline_journal_settlement_one_settled_per_sequence" ON "offline_journal_settlement"("tenant_id", "enrollment_id", "sequence")
  WHERE "status" = 'settled';
ALTER TABLE "offline_journal_settlement" ADD CONSTRAINT "offline_journal_settlement_review_fkey" FOREIGN KEY ("tenant_id", "branch_id", "review_id") REFERENCES "offline_journal_review"("tenant_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "offline_journal_settlement" ADD CONSTRAINT "offline_journal_settlement_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- What is approved is what is written: the decision and reason never change. To change them,
-- cancel and prepare again, so an approval can never cover edited content.
CREATE FUNCTION pc_offline_journal_settlement_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE progress text[] := ARRAY['status', 'execution_approval_id', 'approved_by', 'settled_at',
  'result', 'cancelled_by', 'cancelled_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'offline_journal_settlement rows must be retained'; END IF;
  IF (to_jsonb(NEW) - progress) IS DISTINCT FROM (to_jsonb(OLD) - progress) THEN
    RAISE EXCEPTION 'A journal settlement is immutable; cancel it and prepare a new one';
  END IF;
  IF OLD.status IN ('settled', 'cancelled') THEN
    RAISE EXCEPTION 'A finished journal settlement cannot change';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER offline_journal_settlement_immutable BEFORE UPDATE OR DELETE ON "offline_journal_settlement"
  FOR EACH ROW EXECUTE FUNCTION pc_offline_journal_settlement_immutable();

-- A recorded entry's sale always waits on a stock case; its lines that central stock could cover
-- say `entry_reviewed` (a manager recorded a refused entry, so its stock is confirmed at the
-- counter). Added NOT VALID and validated by the next migration.
ALTER TABLE offline_stock_discrepancy_line DROP CONSTRAINT offline_stock_discrepancy_line_shape;
ALTER TABLE offline_stock_discrepancy_line ADD CONSTRAINT offline_stock_discrepancy_line_shape CHECK (
  "sold_quantity" > 0 AND "available_quantity_at_sync" >= 0
  AND "shortfall_quantity" = GREATEST("sold_quantity" - "available_quantity_at_sync", 0)
  AND "reason" IN ('shortfall', 'batch_under_review', 'sale_pending', 'entry_reviewed')
  AND (("reason" = 'shortfall') = ("shortfall_quantity" > 0))
) NOT VALID;

-- Exact approval of a journal settlement. Every existing pair is kept. Added NOT VALID and
-- validated by the next migration, so deploying takes no long lock on management_approval.
ALTER TABLE management_approval DROP CONSTRAINT management_approval_shape;
ALTER TABLE management_approval ADD CONSTRAINT management_approval_shape CHECK (
  document_version > 0 AND document_digest ~ '^[0-9a-f]{64}$' AND policy_version = 1
  AND jsonb_typeof(material) = 'object' AND length(trim(reason)) > 0
  AND ((document_type = 'purchase_order' AND authorized_action = 'purchase_order.receive')
    OR (document_type = 'transfer' AND authorized_action = 'transfer.ship')
    OR (document_type = 'goods_return' AND authorized_action = 'goods_return.complete')
    OR (document_type = 'stocktake' AND authorized_action = 'stocktake.post')
    OR (document_type = 'held_adjustment' AND authorized_action = 'held_adjustment.post')
    OR (document_type = 'held_delivery' AND authorized_action = 'held_delivery.post')
    OR (document_type = 'sale_refund' AND authorized_action = 'sale_refund.execute')
    OR (document_type = 'prepared_receipt' AND authorized_action = 'prepared_receipt.post')
    OR (document_type = 'offline_stock_resolution' AND authorized_action = 'offline_stock_resolution.execute')
    OR (document_type = 'offline_journal_settlement' AND authorized_action = 'offline_journal_settlement.execute'))
  AND (expires_at IS NULL OR expires_at > approved_at)
  AND ((revoked_at IS NULL AND revocation_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL
      AND revoked_at >= approved_at AND length(trim(revocation_reason)) > 0))
) NOT VALID;

-- Reviewing and settling refused offline entries: owners and managers by default. Granted only
-- when this statement adds the permission, so re-running never hands it back to a role it was
-- taken from.
WITH added AS (
  INSERT INTO "permission" ("key", "module", "label", "description") VALUES
    ('sales.review_offline_entries', 'sales',
     'Review refused offline sales',
     'Decide what happens to an offline sale or shift record the server refused: record it as it happened or don''t honour it. The counter that sent it can''t sell until this is done.')
  ON CONFLICT ("key") DO NOTHING
  RETURNING "key"
)
INSERT INTO "role_permission" ("id", "tenant_id", "role_id", "permission_key")
SELECT gen_random_uuid(), r."tenant_id", r."id", added."key"
FROM "role" r CROSS JOIN added
WHERE r."is_system" = true AND r."key" IN ('owner', 'manager')
ON CONFLICT ("role_id", "permission_key") DO NOTHING;

CREATE POLICY pc_tenant_isolation ON offline_journal_settlement
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- RLS remains disabled, consistent with the staged inventory.
