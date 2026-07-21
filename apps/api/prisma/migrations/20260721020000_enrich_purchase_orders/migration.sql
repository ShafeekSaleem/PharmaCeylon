-- AlterEnum
ALTER TYPE "PoStatus" ADD VALUE IF NOT EXISTS 'pending_approval';

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "PoPriority" AS ENUM ('low', 'normal', 'high', 'urgent');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterTable purchase_order
ALTER TABLE "purchase_order"
  ADD COLUMN IF NOT EXISTS "priority" "PoPriority" NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS "supplier_reference" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "delivery_instructions" TEXT,
  ADD COLUMN IF NOT EXISTS "payment_terms_days" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS "shipping_charges" DECIMAL(12, 2) NOT NULL DEFAULT 0;

-- AlterTable purchase_order_item
ALTER TABLE "purchase_order_item"
  ADD COLUMN IF NOT EXISTS "discount_percent" DECIMAL(5, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "tax_percent" DECIMAL(5, 2) NOT NULL DEFAULT 18;
