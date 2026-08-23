-- AlterTable
ALTER TABLE "batch" ADD COLUMN     "supplier_id" UUID;

-- CreateIndex
CREATE INDEX "batch_tenant_id_supplier_id_idx" ON "batch"("tenant_id", "supplier_id");

-- AddForeignKey
ALTER TABLE "batch" ADD CONSTRAINT "batch_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
