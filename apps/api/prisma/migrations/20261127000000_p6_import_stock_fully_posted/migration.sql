-- P6 #52: opening stock posted a category at a time. Set once every staged row has its batch,
-- so the Counter work poll skips a fully posted import without reading its rows.
-- AlterTable
ALTER TABLE "product_import" ADD COLUMN "stock_fully_posted_at" TIMESTAMP(3);

-- Backfill: imports already fully posted. The time of the last post was not recorded, so the
-- first post's time stands in.
UPDATE "product_import"
SET "stock_fully_posted_at" = "stock_posted_at"
WHERE "stock_staged"
  AND "stock_posted_at" IS NOT NULL
  AND NOT jsonb_path_exists("staged_stock", '$[*] ? (!exists(@.postedBatchId) || @.postedBatchId == null)');
