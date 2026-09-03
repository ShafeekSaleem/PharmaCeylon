-- "Bring your own product list" importer: a pharmacy moving from another system uploads one
-- file carrying products and opening stock, and can undo the run while nothing has been sold.

-- Day-one balances are a different event from later corrections. Recording them as
-- adjustment_in loses that distinction permanently, and stock valuation, shrinkage analysis
-- and the first stocktake all need it.
ALTER TYPE "StockMovementType" ADD VALUE 'opening_stock';

-- CreateEnum
CREATE TYPE "ProductImportStatus" AS ENUM ('running', 'completed', 'failed', 'undone');

-- CreateTable
CREATE TABLE "product_import" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID,
    "created_by" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "status" "ProductImportStatus" NOT NULL DEFAULT 'running',
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "products_created" INTEGER NOT NULL DEFAULT 0,
    "products_updated" INTEGER NOT NULL DEFAULT 0,
    "products_ranged" INTEGER NOT NULL DEFAULT 0,
    "batches_created" INTEGER NOT NULL DEFAULT 0,
    "units_posted" INTEGER NOT NULL DEFAULT 0,
    "rows_failed" INTEGER NOT NULL DEFAULT 0,
    "expiry_review_count" INTEGER NOT NULL DEFAULT 0,
    "error_report" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "undone_at" TIMESTAMP(3),

    CONSTRAINT "product_import_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_import_tenant_id_created_at_idx" ON "product_import"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "product_import" ADD CONSTRAINT "product_import_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_import" ADD CONSTRAINT "product_import_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_import" ADD CONSTRAINT "product_import_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Provenance stamp, so an import can be undone. Plain column rather than a relation, the same
-- way StockLedger.referenceId points at whatever caused a movement.
ALTER TABLE "product" ADD COLUMN "import_id" UUID;
CREATE INDEX "product_tenant_id_import_id_idx" ON "product"("tenant_id", "import_id");

-- Batches imported without a real expiry date carry a far-future placeholder. Flagged so they
-- stay out of expiry alerts (which would otherwise report a date nobody entered) and can be
-- listed for review; the placeholder sorts last under FEFO, so they are never picked early.
ALTER TABLE "batch" ADD COLUMN "needs_expiry_review" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "batch_tenant_id_branch_id_needs_expiry_review_idx"
  ON "batch"("tenant_id", "branch_id", "needs_expiry_review");

-- New permission key. ensureRbacSeed() only grants a new key when a tenant's Role row is first
-- created, so it never reaches existing tenants — backfill it here, as
-- 20260829090100_backfill_branches_manage_permission did.
INSERT INTO "permission" ("key", "module", "label", "description")
VALUES (
  'products.import',
  'products',
  'Import products',
  'Upload a product list from another system, with optional opening stock.'
)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permission" ("id", "tenant_id", "role_id", "permission_key")
SELECT gen_random_uuid(), r."tenant_id", r."id", 'products.import'
FROM "role" r
WHERE r."key" IN ('owner', 'manager', 'inventory_clerk') AND r."is_system" = true
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
