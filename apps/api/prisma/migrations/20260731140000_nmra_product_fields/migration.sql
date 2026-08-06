-- AlterTable
ALTER TABLE "product" ADD COLUMN "pack_type" TEXT;
ALTER TABLE "product" ADD COLUMN "registration_no" TEXT;
ALTER TABLE "product" ADD COLUMN "registration_date" DATE;
ALTER TABLE "product" ADD COLUMN "schedule" TEXT;
ALTER TABLE "product" ADD COLUMN "reg_type" TEXT;
ALTER TABLE "product" ADD COLUMN "dossier_no" TEXT;
ALTER TABLE "product" ADD COLUMN "country_of_origin" TEXT;
ALTER TABLE "product" ADD COLUMN "local_agent" TEXT;

-- CreateIndex
CREATE INDEX "product_tenant_id_registration_no_idx" ON "product"("tenant_id", "registration_no");

-- CreateIndex
CREATE INDEX "product_tenant_id_schedule_idx" ON "product"("tenant_id", "schedule");
