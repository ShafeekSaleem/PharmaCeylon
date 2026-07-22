-- AlterEnum
ALTER TYPE "TransferStatus" ADD VALUE IF NOT EXISTS 'partially_received';

-- AlterTable
ALTER TABLE "transfer" ADD COLUMN IF NOT EXISTS "notes" TEXT;
ALTER TABLE "transfer" ADD COLUMN IF NOT EXISTS "expected_on" DATE;

-- AlterTable
ALTER TABLE "transfer_item" ADD COLUMN IF NOT EXISTS "received_qty" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "transfer_tenant_id_from_branch_id_status_idx" ON "transfer"("tenant_id", "from_branch_id", "status");
CREATE INDEX IF NOT EXISTS "transfer_tenant_id_to_branch_id_status_idx" ON "transfer"("tenant_id", "to_branch_id", "status");
