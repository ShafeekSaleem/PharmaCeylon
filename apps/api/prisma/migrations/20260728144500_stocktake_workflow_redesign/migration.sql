DO $$ BEGIN
  CREATE TYPE "StocktakeMovementMode" AS ENUM ('continue_and_reconcile', 'freeze_transactions');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "StocktakeCountStatus" AS ENUM ('pending', 'counted', 'submitted', 'recount_requested', 'recounted', 'reviewed', 'approved', 'posted');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "StocktakeCondition" AS ENUM ('saleable', 'damaged', 'expired', 'quarantined', 'opened_pack', 'missing_label', 'temperature_affected');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "StocktakeVarianceReason" AS ENUM ('unrecorded_sale', 'unrecorded_receipt', 'damaged_stock', 'expired_stock', 'supplier_shortage', 'wrong_batch_used', 'unit_conversion_error', 'transfer_not_recorded', 'return_not_recorded', 'counting_error', 'suspected_theft_loss', 'other');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable
ALTER TABLE "stocktake"
ADD COLUMN IF NOT EXISTS "approved_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "approved_by" UUID,
ADD COLUMN IF NOT EXISTS "area_label" VARCHAR(160),
ADD COLUMN IF NOT EXISTS "expected_completion_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "movement_mode" "StocktakeMovementMode" NOT NULL DEFAULT 'continue_and_reconcile',
ADD COLUMN IF NOT EXISTS "posted_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "posted_by" UUID,
ADD COLUMN IF NOT EXISTS "review_started_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "reviewer_id" UUID,
ADD COLUMN IF NOT EXISTS "scheduled_for" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "snapshot_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "started_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "submitted_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "title" VARCHAR(160);

-- AlterTable
ALTER TABLE "stocktake_line"
ADD COLUMN IF NOT EXISTS "approved_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "approved_by" UUID,
ADD COLUMN IF NOT EXISTS "condition" "StocktakeCondition" NOT NULL DEFAULT 'saleable',
ADD COLUMN IF NOT EXISTS "posted_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "review_note" VARCHAR(512),
ADD COLUMN IF NOT EXISTS "review_reason" "StocktakeVarianceReason",
ADD COLUMN IF NOT EXISTS "review_resolution" VARCHAR(512),
ADD COLUMN IF NOT EXISTS "reviewed_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "reviewed_by" UUID,
ADD COLUMN IF NOT EXISTS "status" "StocktakeCountStatus" NOT NULL DEFAULT 'pending';

-- CreateTable
CREATE TABLE IF NOT EXISTS "stocktake_assignment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "stocktake_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "area_label" VARCHAR(160),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stocktake_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "stocktake_snapshot_line" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "stocktake_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "snapshot_qty" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stocktake_snapshot_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "stocktake_count_entry" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "stocktake_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "counted_qty" INTEGER NOT NULL,
    "condition" "StocktakeCondition" NOT NULL DEFAULT 'saleable',
    "note" VARCHAR(512),
    "is_recount" BOOLEAN NOT NULL DEFAULT false,
    "counted_by" UUID NOT NULL,
    "counted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stocktake_count_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "stocktake_posting" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "stocktake_id" UUID NOT NULL,
    "posted_by" UUID NOT NULL,
    "posted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" VARCHAR(512),

    CONSTRAINT "stocktake_posting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "stocktake_posting_line" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "posting_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "qty_delta" INTEGER NOT NULL,
    "movement_type" "StockMovementType" NOT NULL,
    "ledger_reference_id" UUID NOT NULL,
    "reason" VARCHAR(512),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "stocktake_posting_line_pkey" PRIMARY KEY ("id")
);

-- Backfill legacy stocktake metadata before enum replacement.
UPDATE "stocktake"
SET
  "snapshot_at" = COALESCE("snapshot_at", "frozen_at"),
  "started_at" = COALESCE("started_at", "frozen_at"),
  "submitted_at" = COALESCE("submitted_at", "completed_at"),
  "review_started_at" = COALESCE("review_started_at", "completed_at"),
  "approved_at" = COALESCE("approved_at", "completed_at"),
  "posted_at" = COALESCE("posted_at", "completed_at"),
  "approved_by" = COALESCE("approved_by", "completed_by"),
  "posted_by" = COALESCE("posted_by", "completed_by"),
  "title" = COALESCE("title", "stocktake_number");

-- AlterEnum
BEGIN;
CREATE TYPE "StocktakeStatus_new" AS ENUM ('draft', 'scheduled', 'counting', 'submitted', 'under_review', 'approved', 'posted', 'completed', 'cancelled');
ALTER TABLE "public"."stocktake" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "stocktake" ALTER COLUMN "status" TYPE "StocktakeStatus_new" USING (
  CASE
    WHEN "status"::text = 'in_progress' THEN 'counting'
    ELSE "status"::text
  END::"StocktakeStatus_new"
);
ALTER TYPE "StocktakeStatus" RENAME TO "StocktakeStatus_old";
ALTER TYPE "StocktakeStatus_new" RENAME TO "StocktakeStatus";
DROP TYPE "public"."StocktakeStatus_old";
ALTER TABLE "stocktake" ALTER COLUMN "status" SET DEFAULT 'draft';
COMMIT;

-- Backfill line statuses from legacy counted/variance state.
UPDATE "stocktake_line"
SET "status" = CASE
  WHEN "counted_qty" IS NULL THEN 'pending'::"StocktakeCountStatus"
  WHEN EXISTS (
    SELECT 1 FROM "stocktake" st
    WHERE st."id" = "stocktake_line"."stocktake_id"
      AND st."status" IN ('completed', 'posted')
  ) THEN 'posted'::"StocktakeCountStatus"
  ELSE 'counted'::"StocktakeCountStatus"
END;

UPDATE "stocktake_line"
SET "posted_at" = (
  SELECT st."posted_at"
  FROM "stocktake" st
  WHERE st."id" = "stocktake_line"."stocktake_id"
)
WHERE EXISTS (
  SELECT 1 FROM "stocktake" st
  WHERE st."id" = "stocktake_line"."stocktake_id"
    AND st."status" IN ('completed', 'posted')
);

UPDATE "stocktake_line"
SET
  "approved_at" = COALESCE("approved_at", "posted_at"),
  "approved_by" = COALESCE("approved_by", (
    SELECT st."approved_by"
    FROM "stocktake" st
    WHERE st."id" = "stocktake_line"."stocktake_id"
  )),
  "reviewed_at" = COALESCE("reviewed_at", "posted_at"),
  "reviewed_by" = COALESCE("reviewed_by", (
    SELECT st."reviewer_id"
    FROM "stocktake" st
    WHERE st."id" = "stocktake_line"."stocktake_id"
  ));

-- Snapshot each existing stocktake line as immutable baseline.
INSERT INTO "stocktake_snapshot_line" (
  "id",
  "tenant_id",
  "stocktake_id",
  "line_id",
  "product_id",
  "batch_id",
  "snapshot_qty"
)
SELECT
  gen_random_uuid(),
  sl."tenant_id",
  sl."stocktake_id",
  sl."id",
  sl."product_id",
  sl."batch_id",
  sl."system_qty"
FROM "stocktake_line" sl
WHERE NOT EXISTS (
  SELECT 1
  FROM "stocktake_snapshot_line" ssl
  WHERE ssl."line_id" = sl."id"
);

-- Backfill count history from existing counted values.
INSERT INTO "stocktake_count_entry" (
  "id",
  "tenant_id",
  "stocktake_id",
  "line_id",
  "counted_qty",
  "note",
  "counted_by",
  "counted_at"
)
SELECT
  gen_random_uuid(),
  sl."tenant_id",
  sl."stocktake_id",
  sl."id",
  sl."counted_qty",
  sl."note",
  st."counted_by",
  COALESCE(sl."counted_at", st."started_at", st."created_at")
FROM "stocktake_line" sl
JOIN "stocktake" st ON st."id" = sl."stocktake_id"
WHERE sl."counted_qty" IS NOT NULL
AND NOT EXISTS (
  SELECT 1
  FROM "stocktake_count_entry" sce
  WHERE sce."line_id" = sl."id"
    AND sce."is_recount" = false
);

-- Backfill assignments from the original counter.
INSERT INTO "stocktake_assignment" (
  "id",
  "tenant_id",
  "stocktake_id",
  "user_id"
)
SELECT
  gen_random_uuid(),
  st."tenant_id",
  st."id",
  st."counted_by"
FROM "stocktake" st
WHERE NOT EXISTS (
  SELECT 1
  FROM "stocktake_assignment" sa
  WHERE sa."stocktake_id" = st."id"
    AND sa."user_id" = st."counted_by"
);

-- Create posting records for already completed stocktakes.
INSERT INTO "stocktake_posting" (
  "id",
  "tenant_id",
  "stocktake_id",
  "posted_by",
  "posted_at",
  "note"
)
SELECT
  gen_random_uuid(),
  st."tenant_id",
  st."id",
  COALESCE(st."posted_by", st."counted_by"),
  COALESCE(st."posted_at", st."updated_at"),
  'Backfilled from legacy completed stocktake'
FROM "stocktake" st
WHERE st."status" = 'completed'
AND NOT EXISTS (
  SELECT 1
  FROM "stocktake_posting" sp
  WHERE sp."stocktake_id" = st."id"
);

INSERT INTO "stocktake_posting_line" (
  "id",
  "tenant_id",
  "posting_id",
  "line_id",
  "qty_delta",
  "movement_type",
  "ledger_reference_id",
  "reason",
  "created_at",
  "created_by"
)
SELECT
  gen_random_uuid(),
  sl."tenant_id",
  sp."id",
  sl."id",
  sl."variance_qty",
  CASE
    WHEN sl."variance_qty" > 0 THEN 'stocktake_in'::"StockMovementType"
    ELSE 'stocktake_out'::"StockMovementType"
  END,
  st."id",
  COALESCE(sl."note", 'Backfilled stocktake adjustment'),
  COALESCE(st."posted_at", st."updated_at"),
  COALESCE(st."posted_by", st."counted_by")
FROM "stocktake_line" sl
JOIN "stocktake" st ON st."id" = sl."stocktake_id"
JOIN "stocktake_posting" sp ON sp."stocktake_id" = st."id"
WHERE st."status" = 'completed'
  AND sl."variance_qty" IS NOT NULL
  AND sl."variance_qty" <> 0
  AND NOT EXISTS (
    SELECT 1
    FROM "stocktake_posting_line" spl
    WHERE spl."posting_id" = sp."id"
      AND spl."line_id" = sl."id"
  );

-- CreateIndex
CREATE INDEX IF NOT EXISTS "stocktake_assignment_tenant_id_user_id_idx" ON "stocktake_assignment"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "stocktake_assignment_stocktake_id_user_id_key" ON "stocktake_assignment"("stocktake_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "stocktake_snapshot_line_line_id_key" ON "stocktake_snapshot_line"("line_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "stocktake_snapshot_line_tenant_id_stocktake_id_idx" ON "stocktake_snapshot_line"("tenant_id", "stocktake_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "stocktake_snapshot_line_stocktake_id_batch_id_key" ON "stocktake_snapshot_line"("stocktake_id", "batch_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "stocktake_count_entry_tenant_id_stocktake_id_line_id_counte_idx" ON "stocktake_count_entry"("tenant_id", "stocktake_id", "line_id", "counted_at" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "stocktake_posting_tenant_id_stocktake_id_idx" ON "stocktake_posting"("tenant_id", "stocktake_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "stocktake_posting_line_tenant_id_posting_id_idx" ON "stocktake_posting_line"("tenant_id", "posting_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "stocktake_posting_line_tenant_id_line_id_idx" ON "stocktake_posting_line"("tenant_id", "line_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "stocktake_tenant_id_branch_id_scheduled_for_idx" ON "stocktake"("tenant_id", "branch_id", "scheduled_for");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "stocktake_line_tenant_id_stocktake_id_status_idx" ON "stocktake_line"("tenant_id", "stocktake_id", "status");

-- AddForeignKey
ALTER TABLE "stocktake" ADD CONSTRAINT "stocktake_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake" ADD CONSTRAINT "stocktake_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake" ADD CONSTRAINT "stocktake_posted_by_fkey" FOREIGN KEY ("posted_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_line" ADD CONSTRAINT "stocktake_line_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_line" ADD CONSTRAINT "stocktake_line_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_assignment" ADD CONSTRAINT "stocktake_assignment_stocktake_id_fkey" FOREIGN KEY ("stocktake_id") REFERENCES "stocktake"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_assignment" ADD CONSTRAINT "stocktake_assignment_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_snapshot_line" ADD CONSTRAINT "stocktake_snapshot_line_stocktake_id_fkey" FOREIGN KEY ("stocktake_id") REFERENCES "stocktake"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_snapshot_line" ADD CONSTRAINT "stocktake_snapshot_line_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "stocktake_line"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_snapshot_line" ADD CONSTRAINT "stocktake_snapshot_line_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_snapshot_line" ADD CONSTRAINT "stocktake_snapshot_line_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_count_entry" ADD CONSTRAINT "stocktake_count_entry_stocktake_id_fkey" FOREIGN KEY ("stocktake_id") REFERENCES "stocktake"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_count_entry" ADD CONSTRAINT "stocktake_count_entry_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "stocktake_line"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_count_entry" ADD CONSTRAINT "stocktake_count_entry_counted_by_fkey" FOREIGN KEY ("counted_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_posting" ADD CONSTRAINT "stocktake_posting_stocktake_id_fkey" FOREIGN KEY ("stocktake_id") REFERENCES "stocktake"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_posting" ADD CONSTRAINT "stocktake_posting_posted_by_fkey" FOREIGN KEY ("posted_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_posting_line" ADD CONSTRAINT "stocktake_posting_line_posting_id_fkey" FOREIGN KEY ("posting_id") REFERENCES "stocktake_posting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_posting_line" ADD CONSTRAINT "stocktake_posting_line_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "stocktake_line"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_posting_line" ADD CONSTRAINT "stocktake_posting_line_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
