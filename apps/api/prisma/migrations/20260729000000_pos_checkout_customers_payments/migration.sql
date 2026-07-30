-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('cash', 'card', 'mobile_wallet');

-- AlterTable
ALTER TABLE "sale" ADD COLUMN     "amount_paid" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "change_due" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "customer_id" UUID,
ADD COLUMN     "notes" VARCHAR(512),
ADD COLUMN     "prescription_id" UUID;

-- CreateTable
CREATE TABLE "customer" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" VARCHAR(32),
    "email" TEXT,
    "address" VARCHAR(512),
    "notes" VARCHAR(512),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescription" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "rx_number" VARCHAR(64) NOT NULL,
    "patient_name" TEXT NOT NULL,
    "doctor_name" TEXT NOT NULL,
    "doctor_reg_no" VARCHAR(64),
    "issued_on" DATE NOT NULL,
    "valid_until" DATE,
    "notes" VARCHAR(512),
    "customer_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prescription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_payment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reference" VARCHAR(128),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "held_sale" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "hold_ref" VARCHAR(32) NOT NULL,
    "label" VARCHAR(120),
    "item_count" INTEGER NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "held_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "held_sale_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_tenant_id_full_name_idx" ON "customer"("tenant_id", "full_name");

-- CreateIndex
CREATE UNIQUE INDEX "customer_tenant_id_phone_key" ON "customer"("tenant_id", "phone");

-- CreateIndex
CREATE INDEX "prescription_tenant_id_branch_id_issued_on_idx" ON "prescription"("tenant_id", "branch_id", "issued_on" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "prescription_tenant_id_branch_id_rx_number_key" ON "prescription"("tenant_id", "branch_id", "rx_number");

-- CreateIndex
CREATE INDEX "sale_payment_tenant_id_sale_id_idx" ON "sale_payment"("tenant_id", "sale_id");

-- CreateIndex
CREATE INDEX "held_sale_tenant_id_branch_id_created_at_idx" ON "held_sale"("tenant_id", "branch_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "held_sale_tenant_id_branch_id_hold_ref_key" ON "held_sale"("tenant_id", "branch_id", "hold_ref");

-- CreateIndex
CREATE INDEX "sale_tenant_id_customer_id_idx" ON "sale"("tenant_id", "customer_id");

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_prescription_id_fkey" FOREIGN KEY ("prescription_id") REFERENCES "prescription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_payment" ADD CONSTRAINT "sale_payment_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "held_sale" ADD CONSTRAINT "held_sale_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "held_sale" ADD CONSTRAINT "held_sale_held_by_fkey" FOREIGN KEY ("held_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
