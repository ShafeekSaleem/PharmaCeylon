-- CreateEnum
CREATE TYPE "HeldAdjustmentStatus" AS ENUM ('awaiting_approval', 'accepted', 'rejected');

-- AlterTable
ALTER TABLE "tenant_settings" ADD COLUMN     "approval_required_write_off_threshold" DECIMAL(14,2);

-- CreateTable
CREATE TABLE "held_adjustment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "kind" VARCHAR(24) NOT NULL,
    "qty" INTEGER NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "note" VARCHAR(512),
    "payload" JSONB NOT NULL,
    "status" "HeldAdjustmentStatus" NOT NULL DEFAULT 'awaiting_approval',
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" UUID,
    "decided_at" TIMESTAMP(3),
    "decision_note" VARCHAR(512),
    "reference_id" UUID,

    CONSTRAINT "held_adjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "held_adjustment_tenant_id_branch_id_status_idx" ON "held_adjustment"("tenant_id", "branch_id", "status");

-- AddForeignKey
ALTER TABLE "held_adjustment" ADD CONSTRAINT "held_adjustment_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "held_adjustment" ADD CONSTRAINT "held_adjustment_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "held_adjustment" ADD CONSTRAINT "held_adjustment_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "held_adjustment" ADD CONSTRAINT "held_adjustment_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "held_adjustment" ADD CONSTRAINT "held_adjustment_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
