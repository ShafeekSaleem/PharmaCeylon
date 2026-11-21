-- P6 #52 decision 1: counter mismatch reports. Decision 2: closing a short transfer on the web.
-- CreateEnum
CREATE TYPE "TransferShortCloseReason" AS ENUM ('never_left_source', 'lost_in_transit');

-- CreateEnum
CREATE TYPE "CounterMismatchProblem" AS ENUM ('fewer_arrived', 'more_arrived', 'different_batch_or_expiry', 'damaged', 'not_on_note', 'cannot_pick');

-- CreateEnum
CREATE TYPE "CounterMismatchStatus" AS ENUM ('open', 'dismissed');

-- AlterTable
ALTER TABLE "transfer" ADD COLUMN     "short_close_note" VARCHAR(500),
ADD COLUMN     "short_close_reason" "TransferShortCloseReason",
ADD COLUMN     "short_closed_at" TIMESTAMP(3),
ADD COLUMN     "short_closed_by" UUID;

-- AlterTable
ALTER TABLE "transfer_item" ADD COLUMN     "closed_qty" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "counter_mismatch_report" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "document_id" UUID NOT NULL,
    "reference" VARCHAR(64) NOT NULL,
    "approval_id" UUID,
    "document_version" INTEGER NOT NULL,
    "line_ref" VARCHAR(64),
    "line_label" VARCHAR(255),
    "problem" "CounterMismatchProblem" NOT NULL,
    "counted_qty" INTEGER,
    "count_unit" VARCHAR(8),
    "note" VARCHAR(500),
    "status" "CounterMismatchStatus" NOT NULL DEFAULT 'open',
    "reported_by" UUID NOT NULL,
    "reported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissed_by" UUID,
    "dismissed_at" TIMESTAMP(3),
    "dismiss_note" VARCHAR(500),

    CONSTRAINT "counter_mismatch_report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "counter_mismatch_report_tenant_id_branch_id_status_idx" ON "counter_mismatch_report"("tenant_id", "branch_id", "status");

-- CreateIndex
CREATE INDEX "counter_mismatch_report_tenant_id_document_id_status_idx" ON "counter_mismatch_report"("tenant_id", "document_id", "status");


-- Ownership and shape. A report names one of the four documents the counter can query, and
-- answers to its status: only a dismissed report carries who dismissed it.
ALTER TABLE "counter_mismatch_report"
  ADD CONSTRAINT "counter_mismatch_report_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id"),
  ADD CONSTRAINT "counter_mismatch_report_branch_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id"),
  ADD CONSTRAINT "counter_mismatch_report_reported_by_fkey" FOREIGN KEY ("reported_by") REFERENCES "app_user"("id"),
  ADD CONSTRAINT "counter_mismatch_report_dismissed_by_fkey" FOREIGN KEY ("dismissed_by") REFERENCES "app_user"("id"),
  ADD CONSTRAINT "counter_mismatch_report_shape" CHECK (
    "kind" IN ('prepared_receipt', 'held_delivery', 'transfer_ship', 'transfer_receive')
    AND "document_version" > 0
    AND ("counted_qty" IS NULL OR "counted_qty" >= 0)
    AND ("count_unit" IS NULL OR "count_unit" IN ('packs', 'units'))
    AND (("status" = 'open' AND "dismissed_by" IS NULL AND "dismissed_at" IS NULL)
      OR ("status" = 'dismissed' AND "dismissed_by" IS NOT NULL AND "dismissed_at" IS NOT NULL))
  );

CREATE POLICY pc_tenant_isolation ON "counter_mismatch_report"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Decision 2: what was closed short never exceeds what was left, and a closed transfer says why.
-- NOT VALID: enforced on every write from now; existing rows all have closed_qty = 0.
ALTER TABLE "transfer_item" ADD CONSTRAINT "transfer_item_closed_qty" CHECK (
  "closed_qty" >= 0 AND "received_qty" + "closed_qty" <= "qty"
) NOT VALID;
ALTER TABLE "transfer" ADD CONSTRAINT "transfer_short_close_shape" CHECK (
  ("short_closed_at" IS NULL AND "short_closed_by" IS NULL AND "short_close_reason" IS NULL)
  OR ("short_closed_at" IS NOT NULL AND "short_closed_by" IS NOT NULL AND "short_close_reason" IS NOT NULL)
) NOT VALID;
