-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "GoodsReturnType" AS ENUM ('customer', 'supplier');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "GoodsReturnStatus" AS ENUM (
    'draft',
    'pending_approval',
    'awaiting_logistics',
    'in_review',
    'completed',
    'rejected',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "goods_return" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "branch_id" UUID NOT NULL,
  "return_number" TEXT NOT NULL,
  "type" "GoodsReturnType" NOT NULL,
  "status" "GoodsReturnStatus" NOT NULL DEFAULT 'draft',
  "customer_name" TEXT,
  "sale_id" UUID,
  "supplier_id" UUID,
  "reason" TEXT,
  "notes" TEXT,
  "amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "requested_by" UUID NOT NULL,
  "approved_by" UUID,
  "processed_by" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "goods_return_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "goods_return_item" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "return_id" UUID NOT NULL,
  "product_id" UUID NOT NULL,
  "batch_id" UUID,
  "qty" INTEGER NOT NULL,
  "unit_price" DECIMAL(12,2) NOT NULL DEFAULT 0,
  CONSTRAINT "goods_return_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "goods_return_tenant_id_branch_id_return_number_key"
  ON "goods_return"("tenant_id", "branch_id", "return_number");
CREATE INDEX IF NOT EXISTS "goods_return_tenant_id_branch_id_status_idx"
  ON "goods_return"("tenant_id", "branch_id", "status");
CREATE INDEX IF NOT EXISTS "goods_return_tenant_id_branch_id_created_at_idx"
  ON "goods_return"("tenant_id", "branch_id", "created_at" DESC);

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "goods_return" ADD CONSTRAINT "goods_return_branch_id_fkey"
    FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "goods_return" ADD CONSTRAINT "goods_return_sale_id_fkey"
    FOREIGN KEY ("sale_id") REFERENCES "sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "goods_return" ADD CONSTRAINT "goods_return_supplier_id_fkey"
    FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "goods_return" ADD CONSTRAINT "goods_return_requested_by_fkey"
    FOREIGN KEY ("requested_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "goods_return" ADD CONSTRAINT "goods_return_approved_by_fkey"
    FOREIGN KEY ("approved_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "goods_return" ADD CONSTRAINT "goods_return_processed_by_fkey"
    FOREIGN KEY ("processed_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "goods_return_item" ADD CONSTRAINT "goods_return_item_return_id_fkey"
    FOREIGN KEY ("return_id") REFERENCES "goods_return"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "goods_return_item" ADD CONSTRAINT "goods_return_item_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "goods_return_item" ADD CONSTRAINT "goods_return_item_batch_id_fkey"
    FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
