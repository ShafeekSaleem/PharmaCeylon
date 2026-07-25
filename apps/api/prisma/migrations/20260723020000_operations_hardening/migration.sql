-- AlterEnum PoStatus
ALTER TYPE "PoStatus" ADD VALUE IF NOT EXISTS 'short_closed';

-- AlterEnum StockMovementType
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'transfer_reserve_out';
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'transfer_reserve_release';
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'quarantine_hold';
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'quarantine_release';
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'stocktake_in';
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'stocktake_out';

-- CreateEnum StocktakeStatus
DO $$ BEGIN
  CREATE TYPE "StocktakeStatus" AS ENUM ('draft', 'in_progress', 'completed', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Document sequence for safe numbering
CREATE TABLE IF NOT EXISTS "document_sequence" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "doc_type" VARCHAR(32) NOT NULL,
    "next_value" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_sequence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "document_sequence_tenant_id_branch_id_doc_type_key"
  ON "document_sequence"("tenant_id", "branch_id", "doc_type");

ALTER TABLE "document_sequence"
  DROP CONSTRAINT IF EXISTS "document_sequence_branch_id_fkey";
ALTER TABLE "document_sequence"
  ADD CONSTRAINT "document_sequence_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Batch quarantine fields
ALTER TABLE "batch" ADD COLUMN IF NOT EXISTS "is_quarantined" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "batch" ADD COLUMN IF NOT EXISTS "quarantined_at" TIMESTAMP(3);
ALTER TABLE "batch" ADD COLUMN IF NOT EXISTS "quarantine_reason" VARCHAR(512);

CREATE INDEX IF NOT EXISTS "batch_tenant_id_branch_id_is_quarantined_idx"
  ON "batch"("tenant_id", "branch_id", "is_quarantined");

-- Unique product per PO
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_order_item_purchase_order_id_product_id_key"
  ON "purchase_order_item"("purchase_order_id", "product_id");

-- Transfer number (backfill existing rows first)
ALTER TABLE "transfer" ADD COLUMN IF NOT EXISTS "transfer_number" TEXT;

UPDATE "transfer"
SET "transfer_number" = 'TR-LEGACY-' || UPPER(SUBSTRING(REPLACE("id"::text, '-', ''), 1, 8))
WHERE "transfer_number" IS NULL;

ALTER TABLE "transfer" ALTER COLUMN "transfer_number" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "transfer_tenant_id_transfer_number_key"
  ON "transfer"("tenant_id", "transfer_number");

-- Goods return RMA links
ALTER TABLE "goods_return" ADD COLUMN IF NOT EXISTS "purchase_order_id" UUID;
ALTER TABLE "goods_return" ADD COLUMN IF NOT EXISTS "goods_receipt_id" UUID;

ALTER TABLE "goods_return"
  DROP CONSTRAINT IF EXISTS "goods_return_purchase_order_id_fkey";
ALTER TABLE "goods_return"
  ADD CONSTRAINT "goods_return_purchase_order_id_fkey"
  FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "goods_return"
  DROP CONSTRAINT IF EXISTS "goods_return_goods_receipt_id_fkey";
ALTER TABLE "goods_return"
  ADD CONSTRAINT "goods_return_goods_receipt_id_fkey"
  FOREIGN KEY ("goods_receipt_id") REFERENCES "goods_receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Stocktake
CREATE TABLE IF NOT EXISTS "stocktake" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "stocktake_number" TEXT NOT NULL,
    "status" "StocktakeStatus" NOT NULL DEFAULT 'draft',
    "notes" TEXT,
    "counted_by" UUID NOT NULL,
    "completed_by" UUID,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stocktake_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "stocktake_tenant_id_branch_id_stocktake_number_key"
  ON "stocktake"("tenant_id", "branch_id", "stocktake_number");
CREATE INDEX IF NOT EXISTS "stocktake_tenant_id_branch_id_status_idx"
  ON "stocktake"("tenant_id", "branch_id", "status");

ALTER TABLE "stocktake"
  DROP CONSTRAINT IF EXISTS "stocktake_branch_id_fkey";
ALTER TABLE "stocktake"
  ADD CONSTRAINT "stocktake_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stocktake"
  DROP CONSTRAINT IF EXISTS "stocktake_counted_by_fkey";
ALTER TABLE "stocktake"
  ADD CONSTRAINT "stocktake_counted_by_fkey"
  FOREIGN KEY ("counted_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stocktake"
  DROP CONSTRAINT IF EXISTS "stocktake_completed_by_fkey";
ALTER TABLE "stocktake"
  ADD CONSTRAINT "stocktake_completed_by_fkey"
  FOREIGN KEY ("completed_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "stocktake_line" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "stocktake_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "system_qty" INTEGER NOT NULL,
    "counted_qty" INTEGER,
    "variance_qty" INTEGER,

    CONSTRAINT "stocktake_line_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "stocktake_line_stocktake_id_batch_id_key"
  ON "stocktake_line"("stocktake_id", "batch_id");

ALTER TABLE "stocktake_line"
  DROP CONSTRAINT IF EXISTS "stocktake_line_stocktake_id_fkey";
ALTER TABLE "stocktake_line"
  ADD CONSTRAINT "stocktake_line_stocktake_id_fkey"
  FOREIGN KEY ("stocktake_id") REFERENCES "stocktake"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "stocktake_line"
  DROP CONSTRAINT IF EXISTS "stocktake_line_product_id_fkey";
ALTER TABLE "stocktake_line"
  ADD CONSTRAINT "stocktake_line_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stocktake_line"
  DROP CONSTRAINT IF EXISTS "stocktake_line_batch_id_fkey";
ALTER TABLE "stocktake_line"
  ADD CONSTRAINT "stocktake_line_batch_id_fkey"
  FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
