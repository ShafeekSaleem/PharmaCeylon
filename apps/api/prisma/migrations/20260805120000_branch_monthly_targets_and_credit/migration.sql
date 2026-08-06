ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'credit';

-- CreateTable
CREATE TABLE "branch_monthly_target" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "year_month" VARCHAR(7) NOT NULL,
    "target_amount" DECIMAL(14,2) NOT NULL,
    "manager_user_id" UUID,
    "notes" VARCHAR(256),
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_monthly_target_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "branch_monthly_target_tenant_id_year_month_idx" ON "branch_monthly_target"("tenant_id", "year_month");

-- CreateIndex
CREATE INDEX "branch_monthly_target_tenant_id_manager_user_id_idx" ON "branch_monthly_target"("tenant_id", "manager_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "branch_monthly_target_tenant_id_branch_id_year_month_key" ON "branch_monthly_target"("tenant_id", "branch_id", "year_month");

-- AddForeignKey
ALTER TABLE "branch_monthly_target" ADD CONSTRAINT "branch_monthly_target_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_monthly_target" ADD CONSTRAINT "branch_monthly_target_manager_user_id_fkey" FOREIGN KEY ("manager_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_monthly_target" ADD CONSTRAINT "branch_monthly_target_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
