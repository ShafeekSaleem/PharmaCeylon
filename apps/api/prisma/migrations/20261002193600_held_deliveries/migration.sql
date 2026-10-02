-- CreateEnum
CREATE TYPE "HeldDeliveryStatus" AS ENUM ('awaiting_approval', 'accepted', 'rejected');

-- CreateTable
CREATE TABLE "held_delivery" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "status" "HeldDeliveryStatus" NOT NULL DEFAULT 'awaiting_approval',
    "reasons" TEXT[],
    "detail" VARCHAR(1000),
    "payload" JSONB NOT NULL,
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" UUID,
    "decided_at" TIMESTAMP(3),
    "decision_note" VARCHAR(512),
    "corrected" BOOLEAN NOT NULL DEFAULT false,
    "goods_receipt_id" UUID,

    CONSTRAINT "held_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "held_delivery_goods_receipt_id_key" ON "held_delivery"("goods_receipt_id");

-- CreateIndex
CREATE INDEX "held_delivery_tenant_id_branch_id_status_idx" ON "held_delivery"("tenant_id", "branch_id", "status");

-- CreateIndex
CREATE INDEX "held_delivery_purchase_order_id_status_idx" ON "held_delivery"("purchase_order_id", "status");

-- AddForeignKey
ALTER TABLE "held_delivery" ADD CONSTRAINT "held_delivery_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "held_delivery" ADD CONSTRAINT "held_delivery_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "held_delivery" ADD CONSTRAINT "held_delivery_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "held_delivery" ADD CONSTRAINT "held_delivery_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "held_delivery" ADD CONSTRAINT "held_delivery_goods_receipt_id_fkey" FOREIGN KEY ("goods_receipt_id") REFERENCES "goods_receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
