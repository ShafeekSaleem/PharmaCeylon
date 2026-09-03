-- Split the three meanings that were all riding on product.is_active:
--   range_status            — does this pharmacy sell it?   (import-owned on the way in)
--   is_active               — is this record enabled?       (pharmacist-owned only)
--   nmra_registration_valid — is the registration current?  (import-owned, NMRA rows only)

-- CreateEnum
CREATE TYPE "ProductRangeStatus" AS ENUM ('REFERENCE', 'RANGED');

-- AlterTable
ALTER TABLE "product"
  ADD COLUMN "range_status" "ProductRangeStatus" NOT NULL DEFAULT 'RANGED',
  ADD COLUMN "ranged_at" TIMESTAMP(3),
  ADD COLUMN "nmra_registration_valid" BOOLEAN;

-- Carry the meaning the importer had been writing onto is_active over to its own field,
-- so registration validity survives without is_active continuing to answer for it.
UPDATE "product" SET "nmra_registration_valid" = "is_active" WHERE "source" = 'NMRA';

-- Backfill: an NMRA-sourced product is part of the pharmacy's own range only if it has ever
-- been traded. Everything else the pharmacy created itself (MANUAL/SUPPLIER/CSV_IMPORT/
-- BARCODE) stays RANGED. No pharmacy loses access to a product it has ever traded.
UPDATE "product" p
SET "range_status" = 'REFERENCE'
WHERE p."source" = 'NMRA'
  AND NOT EXISTS (SELECT 1 FROM "batch"               t WHERE t."product_id" = p."id")
  AND NOT EXISTS (SELECT 1 FROM "stock_ledger"        t WHERE t."product_id" = p."id")
  AND NOT EXISTS (SELECT 1 FROM "purchase_order_item" t WHERE t."product_id" = p."id")
  AND NOT EXISTS (SELECT 1 FROM "goods_receipt_item"  t WHERE t."product_id" = p."id")
  AND NOT EXISTS (SELECT 1 FROM "sale_item"           t WHERE t."product_id" = p."id")
  AND NOT EXISTS (SELECT 1 FROM "transfer_item"       t WHERE t."product_id" = p."id")
  AND NOT EXISTS (SELECT 1 FROM "goods_return_item"   t WHERE t."product_id" = p."id")
  AND NOT EXISTS (SELECT 1 FROM "stocktake_line"      t WHERE t."product_id" = p."id");

-- Existing ranged products have been part of the range since they were created; without this
-- the "ranged since" column would read as empty for every pre-migration product.
UPDATE "product" SET "ranged_at" = "created_at" WHERE "range_status" = 'RANGED';

-- Hand is_active back to the pharmacist on untraded registry rows.
--
-- Before this change is_active was the only field available, so it was carrying two answers
-- that were never the same question: the importer wrote registration validity into it, and
-- tenants (and the demo seed) switched it off in bulk purely to keep the registry out of
-- their product list. Both of those meanings now have their own field —
-- nmra_registration_valid above, and range_status — so a false left here would keep the
-- reference catalog invisible in Search Catalog and defeat the point of importing it.
--
-- Deliberately scoped to NMRA REFERENCE rows: a product with trade history stays RANGED and
-- keeps whatever is_active it has, because a deactivation there is a real decision about a
-- line the pharmacy sells. An untraded reference row is not sellable either way — it is kept
-- out of pickers by range_status, and POS is batch-driven — so nothing becomes sellable that
-- was not sellable before.
UPDATE "product"
SET "is_active" = true
WHERE "source" = 'NMRA' AND "range_status" = 'REFERENCE' AND "is_active" = false;

-- CreateIndex
CREATE INDEX "product_tenant_id_range_status_idx" ON "product"("tenant_id", "range_status");
