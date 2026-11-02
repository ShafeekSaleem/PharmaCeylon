-- P1 #47: validate the constraints the previous migration added NOT VALID. Its own migration, so
-- its own transaction: VALIDATE takes SHARE UPDATE EXCLUSIVE on `sale`, which lets checkouts and
-- other writes continue while the existing rows (all with a null registration) are scanned.

ALTER TABLE "sale" VALIDATE CONSTRAINT "sale_tenant_id_dispensed_by_dispenser_registration_id_fkey";

ALTER TABLE sale VALIDATE CONSTRAINT sale_dispenser_registration_check;
