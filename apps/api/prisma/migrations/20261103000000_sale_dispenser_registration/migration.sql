-- P1 #47: the SLMC registration a controlled sale's dispenser was checked against at checkout.
-- Written in the checkout's own transaction, under the registration's share lock. The composite
-- key pins it to the dispenser in this tenant, so a sale can't cite someone else's registration.
-- Additive: existing sales keep a null.

CREATE UNIQUE INDEX "pharmacist_registration_tenant_id_user_id_id_key" ON "pharmacist_registration"("tenant_id", "user_id", "id");

ALTER TABLE "sale" ADD COLUMN "dispenser_registration_id" UUID;

ALTER TABLE "sale" ADD CONSTRAINT "sale_tenant_id_dispensed_by_dispenser_registration_id_fkey" FOREIGN KEY ("tenant_id", "dispensed_by", "dispenser_registration_id") REFERENCES "pharmacist_registration"("tenant_id", "user_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A null dispenser would leave the key unchecked (MATCH SIMPLE): a registration needs a dispenser.
ALTER TABLE sale ADD CONSTRAINT sale_dispenser_registration_check CHECK (
  dispenser_registration_id IS NULL OR dispensed_by IS NOT NULL
);
