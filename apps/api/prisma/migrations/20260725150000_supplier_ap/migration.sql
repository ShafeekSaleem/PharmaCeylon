-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "SupplierType" AS ENUM ('distributor', 'importer', 'manufacturer', 'wholesaler', 'other');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "SupplierStatus" AS ENUM ('active', 'on_hold', 'inactive');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "SupplierInvoiceStatus" AS ENUM ('open', 'partial', 'paid', 'voided');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterTable supplier
ALTER TABLE "supplier" ADD COLUMN IF NOT EXISTS "type" "SupplierType" NOT NULL DEFAULT 'distributor';
ALTER TABLE "supplier" ADD COLUMN IF NOT EXISTS "status" "SupplierStatus" NOT NULL DEFAULT 'active';
ALTER TABLE "supplier" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "supplier" ADD COLUMN IF NOT EXISTS "email" TEXT;
ALTER TABLE "supplier" ADD COLUMN IF NOT EXISTS "contact_name" TEXT;

-- Backfill status from legacy is_active
UPDATE "supplier" SET "status" = 'inactive' WHERE "is_active" = false AND "status" = 'active';
UPDATE "supplier" SET "is_active" = false WHERE "status" = 'inactive';
UPDATE "supplier" SET "is_active" = true WHERE "status" IN ('active', 'on_hold');

CREATE INDEX IF NOT EXISTS "supplier_tenant_id_status_idx" ON "supplier"("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "supplier_tenant_id_type_idx" ON "supplier"("tenant_id", "type");

-- CreateTable supplier_invoice
CREATE TABLE IF NOT EXISTS "supplier_invoice" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "branch_id" UUID,
    "invoice_number" TEXT NOT NULL,
    "goods_receipt_id" UUID,
    "invoice_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "total_amount" DECIMAL(14,2) NOT NULL,
    "paid_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "SupplierInvoiceStatus" NOT NULL DEFAULT 'open',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_invoice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "supplier_invoice_goods_receipt_id_key" ON "supplier_invoice"("goods_receipt_id");
CREATE UNIQUE INDEX IF NOT EXISTS "supplier_invoice_tenant_id_invoice_number_key" ON "supplier_invoice"("tenant_id", "invoice_number");
CREATE INDEX IF NOT EXISTS "supplier_invoice_tenant_id_supplier_id_idx" ON "supplier_invoice"("tenant_id", "supplier_id");
CREATE INDEX IF NOT EXISTS "supplier_invoice_tenant_id_status_idx" ON "supplier_invoice"("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "supplier_invoice_tenant_id_due_date_idx" ON "supplier_invoice"("tenant_id", "due_date");

DO $$ BEGIN
  ALTER TABLE "supplier_invoice" ADD CONSTRAINT "supplier_invoice_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "supplier_invoice" ADD CONSTRAINT "supplier_invoice_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "supplier_invoice" ADD CONSTRAINT "supplier_invoice_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "supplier_invoice" ADD CONSTRAINT "supplier_invoice_goods_receipt_id_fkey" FOREIGN KEY ("goods_receipt_id") REFERENCES "goods_receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
