-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "StocktakeScope" AS ENUM ('full', 'cycle', 'near_expiry', 'quarantined', 'zero_stock', 'custom');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterTable stocktake
ALTER TABLE "stocktake" ADD COLUMN IF NOT EXISTS "scope" "StocktakeScope" NOT NULL DEFAULT 'full';
ALTER TABLE "stocktake" ADD COLUMN IF NOT EXISTS "blind_count" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "stocktake" ADD COLUMN IF NOT EXISTS "frozen_at" TIMESTAMP(3);
ALTER TABLE "stocktake" ADD COLUMN IF NOT EXISTS "near_expiry_days" INTEGER;

-- AlterTable stocktake_line
ALTER TABLE "stocktake_line" ADD COLUMN IF NOT EXISTS "note" VARCHAR(512);
ALTER TABLE "stocktake_line" ADD COLUMN IF NOT EXISTS "counted_at" TIMESTAMP(3);
