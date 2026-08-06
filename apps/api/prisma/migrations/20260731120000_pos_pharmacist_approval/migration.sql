-- Pharmacist till PIN (optional; login password remains fallback when unset).
ALTER TABLE "app_user" ADD COLUMN "pos_pin_hash" TEXT;
ALTER TABLE "app_user" ADD COLUMN "failed_pos_pin_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "app_user" ADD COLUMN "pos_pin_locked_until" TIMESTAMP(3);

-- Who authorised controlled dispense (cashier can remain sold_by).
ALTER TABLE "sale" ADD COLUMN "dispensed_by" UUID;
ALTER TABLE "sale" ADD CONSTRAINT "sale_dispensed_by_fkey" FOREIGN KEY ("dispensed_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "sale_tenant_id_dispensed_by_idx" ON "sale"("tenant_id", "dispensed_by");

-- Prescription-required vs controlled (schedule) distinction.
ALTER TABLE "product" ADD COLUMN "requires_prescription" BOOLEAN NOT NULL DEFAULT false;
UPDATE "product" SET "requires_prescription" = true WHERE "is_controlled" = true;
