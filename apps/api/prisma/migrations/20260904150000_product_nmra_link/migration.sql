-- Phase 5 of the catalog-organisation plan: link a shop's own product to an NMRA register row.
--
-- `nmra_reference_id` is the live pointer (a self-referencing FK on `product`), used both to
-- apply the link and — via the `claimed_by` back-relation — to filter a claimed reference row
-- out of Search Catalog. `product_nmra_link` is the undo record: every value the link
-- overwrote, so unlinking restores the product exactly as it was, compliance flags included.
-- Alias types "shop_name" and "shop_brand" (for the displaced shop name/brand) need no
-- migration — `product_alias.alias_type` is already free text.

-- AlterEnum
ALTER TYPE "CategoryAssignmentSource" ADD VALUE 'NMRA_LINK';

-- AlterTable
ALTER TABLE "product" ADD COLUMN "nmra_reference_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "product_nmra_reference_id_key" ON "product"("nmra_reference_id");

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_nmra_reference_id_fkey" FOREIGN KEY ("nmra_reference_id") REFERENCES "product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "product_nmra_link" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "reference_product_id" UUID NOT NULL,
    "adopted_fields" JSONB NOT NULL,
    "previous_values" JSONB NOT NULL,
    "linked_by_user_id" UUID,
    "linked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_nmra_link_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_nmra_link_product_id_key" ON "product_nmra_link"("product_id");

-- CreateIndex
CREATE INDEX "product_nmra_link_tenant_id_reference_product_id_idx" ON "product_nmra_link"("tenant_id", "reference_product_id");

-- AddForeignKey
ALTER TABLE "product_nmra_link" ADD CONSTRAINT "product_nmra_link_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
