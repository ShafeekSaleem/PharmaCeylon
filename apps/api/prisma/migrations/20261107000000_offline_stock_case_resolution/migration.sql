-- P5 #51 slice 2: manager review and resolution of offline stock discrepancy cases.
-- A manager prepares a resolution plan for an open case remotely; it is approved exactly (the
-- existing management_approval machinery, new offline_stock_resolution pair) and executed only at
-- the branch's enrolled counter as a signed command (revised D10). Execution posts or links the
-- sale's stock once, records one settlement per batch, closes the case and releases its blocks.

CREATE TYPE "OfflineStockResolutionKind" AS ENUM ('post_now', 'count_and_correct', 'link_existing_settlement');
CREATE TYPE "OfflineStockResolutionStatus" AS ENUM ('prepared', 'approved', 'executed', 'cancelled');

CREATE TABLE "offline_stock_resolution" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "kind" "OfflineStockResolutionKind" NOT NULL,
    -- link_existing_settlement: one entry per case batch naming what already accounted for it;
    -- an empty array for the other kinds.
    "links" JSONB NOT NULL,
    "note" VARCHAR(500),
    "status" "OfflineStockResolutionStatus" NOT NULL DEFAULT 'prepared',
    "approval_version" INTEGER NOT NULL DEFAULT 1,
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "execution_approval_id" UUID,
    "approved_by" UUID,
    "approved_at" TIMESTAMP(3),
    "executed_by" UUID,
    "executed_at" TIMESTAMP(3),
    "execution_command_id" UUID,
    "result" JSONB,
    "cancelled_by" UUID,
    "cancelled_at" TIMESTAMP(3),

    CONSTRAINT "offline_stock_resolution_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "offline_stock_resolution_shape" CHECK (
      jsonb_typeof("links") = 'array'
      AND (("kind" = 'link_existing_settlement') = (jsonb_array_length("links") > 0))
      AND "approval_version" = 1
      AND ("note" IS NULL OR length(btrim("note")) > 0)
      AND (("status" = 'executed') = ("executed_by" IS NOT NULL AND "executed_at" IS NOT NULL AND "result" IS NOT NULL))
      AND (("status" = 'executed') <= ("execution_approval_id" IS NOT NULL))
      AND (("status" = 'cancelled') = ("cancelled_by" IS NOT NULL AND "cancelled_at" IS NOT NULL))
    )
);
CREATE INDEX "offline_stock_resolution_tenant_id_branch_id_status_idx" ON "offline_stock_resolution"("tenant_id", "branch_id", "status");
CREATE INDEX "offline_stock_resolution_case_id_idx" ON "offline_stock_resolution"("case_id");
-- One plan at a time per case, and a case is resolved by one plan only.
CREATE UNIQUE INDEX "offline_stock_resolution_one_open_per_case" ON "offline_stock_resolution"("case_id")
  WHERE "status" IN ('prepared', 'approved');
CREATE UNIQUE INDEX "offline_stock_resolution_one_executed_per_case" ON "offline_stock_resolution"("case_id")
  WHERE "status" = 'executed';
ALTER TABLE "offline_stock_resolution" ADD CONSTRAINT "offline_stock_resolution_case_fkey" FOREIGN KEY ("tenant_id", "branch_id", "case_id") REFERENCES "offline_stock_discrepancy"("tenant_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "offline_stock_resolution" ADD CONSTRAINT "offline_stock_resolution_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- How each batch of a resolved case was accounted for, exactly once (one row per case batch).
-- `posted`: the sale's units were issued from current stock. `counted`: a local physical count
-- set the batch to the count plus every open case's pending units on it (the correction), then
-- the sale was issued. `linked`: an earlier stocktake or local movement already took the units off.
CREATE TABLE "offline_stock_settlement" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "resolution_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "method" VARCHAR(16) NOT NULL,
    "sold_quantity" INTEGER NOT NULL,
    "on_hand_before" INTEGER NOT NULL,
    "pending_on_batch" INTEGER NOT NULL,
    "counted_quantity" INTEGER,
    "counted_at" TIMESTAMP(3),
    "counted_by" UUID,
    "correction_quantity" INTEGER NOT NULL DEFAULT 0,
    "posted_quantity" INTEGER NOT NULL,
    "linked_stocktake_id" UUID,
    "linked_stocktake_line_id" UUID,
    "stock_timeline_digest" CHAR(64) NOT NULL,
    "approval_id" UUID NOT NULL,
    "execution_command_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offline_stock_settlement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "offline_stock_settlement_shape" CHECK (
      "sold_quantity" > 0 AND "pending_on_batch" >= "sold_quantity"
      AND "stock_timeline_digest" ~ '^[0-9a-f]{64}$'
      AND (
        ("method" = 'posted' AND "posted_quantity" = "sold_quantity" AND "correction_quantity" = 0
          AND "counted_quantity" IS NULL AND "counted_at" IS NULL AND "counted_by" IS NULL
          AND "linked_stocktake_id" IS NULL)
        OR ("method" = 'counted' AND "posted_quantity" = "sold_quantity"
          AND "counted_quantity" >= 0 AND "counted_at" IS NOT NULL AND "counted_by" IS NOT NULL
          AND "correction_quantity" = "counted_quantity" + "pending_on_batch" - "on_hand_before"
          AND "linked_stocktake_id" IS NULL)
        OR ("method" = 'linked' AND "posted_quantity" = 0 AND "correction_quantity" = 0
          AND "counted_quantity" IS NULL AND "counted_by" IS NULL
          AND (("linked_stocktake_id" IS NULL) = ("linked_stocktake_line_id" IS NULL)))
      )
    )
);
CREATE UNIQUE INDEX "offline_stock_settlement_case_id_batch_id_key" ON "offline_stock_settlement"("case_id", "batch_id");
CREATE INDEX "offline_stock_settlement_tenant_id_branch_id_batch_id_idx" ON "offline_stock_settlement"("tenant_id", "branch_id", "batch_id");
ALTER TABLE "offline_stock_settlement" ADD CONSTRAINT "offline_stock_settlement_case_fkey" FOREIGN KEY ("tenant_id", "branch_id", "case_id") REFERENCES "offline_stock_discrepancy"("tenant_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "offline_stock_settlement" ADD CONSTRAINT "offline_stock_settlement_resolution_fkey" FOREIGN KEY ("resolution_id") REFERENCES "offline_stock_resolution"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "offline_stock_settlement" ADD CONSTRAINT "offline_stock_settlement_line_fkey" FOREIGN KEY ("case_id", "batch_id") REFERENCES "offline_stock_discrepancy_line"("case_id", "batch_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "offline_stock_settlement" ADD CONSTRAINT "offline_stock_settlement_stocktake_line_fkey" FOREIGN KEY ("linked_stocktake_line_id") REFERENCES "stocktake_line"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A local movement (a write-off or correction taking units off) linked as having already
-- accounted for sold units. Its units are linked at most once across every case: the sum of
-- `quantity` per ledger entry never exceeds the units that entry took off (checked under the
-- batch lock by the resolving transaction, and recorded here per entry).
CREATE TABLE "offline_stock_settlement_link" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "settlement_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "ledger_entry_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offline_stock_settlement_link_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "offline_stock_settlement_link_shape" CHECK ("quantity" > 0)
);
CREATE UNIQUE INDEX "offline_stock_settlement_link_settlement_id_ledger_entry_id_key" ON "offline_stock_settlement_link"("settlement_id", "ledger_entry_id");
CREATE INDEX "offline_stock_settlement_link_tenant_id_ledger_entry_id_idx" ON "offline_stock_settlement_link"("tenant_id", "ledger_entry_id");
ALTER TABLE "offline_stock_settlement_link" ADD CONSTRAINT "offline_stock_settlement_link_settlement_fkey" FOREIGN KEY ("settlement_id") REFERENCES "offline_stock_settlement"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "offline_stock_settlement_link" ADD CONSTRAINT "offline_stock_settlement_link_ledger_fkey" FOREIGN KEY ("ledger_entry_id") REFERENCES "stock_ledger"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The plan's content is what was approved and executed: it never changes. To change a plan,
-- cancel it and prepare another, so an approval can never cover edited content.
CREATE FUNCTION pc_offline_stock_resolution_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE progress text[] := ARRAY['status', 'execution_approval_id', 'approved_by', 'approved_at',
  'executed_by', 'executed_at', 'execution_command_id', 'result', 'cancelled_by', 'cancelled_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'offline_stock_resolution rows must be retained'; END IF;
  IF (to_jsonb(NEW) - progress) IS DISTINCT FROM (to_jsonb(OLD) - progress) THEN
    RAISE EXCEPTION 'A resolution plan is immutable; cancel it and prepare a new one';
  END IF;
  IF OLD.status IN ('executed', 'cancelled') THEN
    RAISE EXCEPTION 'A finished resolution plan cannot change';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER offline_stock_resolution_immutable BEFORE UPDATE OR DELETE ON "offline_stock_resolution"
  FOR EACH ROW EXECUTE FUNCTION pc_offline_stock_resolution_immutable();
-- Settlement evidence is append-only (pc_immutable_offline_evidence from slice 1).
CREATE TRIGGER retain_offline_stock_settlement BEFORE UPDATE OR DELETE ON "offline_stock_settlement"
  FOR EACH ROW EXECUTE FUNCTION pc_immutable_offline_evidence();
CREATE TRIGGER retain_offline_stock_settlement_link BEFORE UPDATE OR DELETE ON "offline_stock_settlement_link"
  FOR EACH ROW EXECUTE FUNCTION pc_immutable_offline_evidence();

-- Exact approval of a resolution plan. Every existing pair is kept. Added NOT VALID and validated
-- by the next migration, so deploying takes no long lock on management_approval.
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
    OR (document_type = 'offline_stock_resolution' AND authorized_action = 'offline_stock_resolution.execute'))
  AND (expires_at IS NULL OR expires_at > approved_at)
  AND ((revoked_at IS NULL AND revocation_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL
      AND revoked_at >= approved_at AND length(trim(revocation_reason)) > 0))
) NOT VALID;

-- Reviewing and authorizing case resolutions: owners and managers by default. Granted only when
-- this statement adds the permission, so re-running never hands it back to a role it was taken from.
WITH added AS (
  INSERT INTO "permission" ("key", "module", "label", "description") VALUES
    ('inventory.resolve_stock_cases', 'inventory',
     'Review and approve offline stock cases',
     'Review offline sales whose stock could not be posted, and approve how each case is resolved. The correction itself is done at the counter.')
  ON CONFLICT ("key") DO NOTHING
  RETURNING "key"
)
INSERT INTO "role_permission" ("id", "tenant_id", "role_id", "permission_key")
SELECT gen_random_uuid(), r."tenant_id", r."id", added."key"
FROM "role" r CROSS JOIN added
WHERE r."is_system" = true AND r."key" IN ('owner', 'manager')
ON CONFLICT ("role_id", "permission_key") DO NOTHING;

CREATE POLICY pc_tenant_isolation ON offline_stock_resolution
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pc_tenant_isolation ON offline_stock_settlement
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pc_tenant_isolation ON offline_stock_settlement_link
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- RLS remains disabled, consistent with the staged inventory.
