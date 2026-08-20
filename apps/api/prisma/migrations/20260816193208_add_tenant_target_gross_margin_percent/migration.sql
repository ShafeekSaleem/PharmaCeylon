-- AlterTable
ALTER TABLE "product_category" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tenant" ADD COLUMN     "target_gross_margin_percent" DECIMAL(5,2);

-- CreateIndex
CREATE INDEX "product_category_map_tenant_id_product_id_idx" ON "product_category_map"("tenant_id", "product_id");

-- RenameIndex
ALTER INDEX "product_category_tenant_id_dimension_name_parent_category_id_ke" RENAME TO "product_category_tenant_id_dimension_name_parent_category_i_key";
