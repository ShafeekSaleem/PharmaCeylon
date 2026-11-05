-- P1 #47: validate the constraints the previous migration added NOT VALID, in their own
-- transaction: VALIDATE takes SHARE UPDATE EXCLUSIVE on `prescription`, so recording continues.

ALTER TABLE "prescription" VALIDATE CONSTRAINT "prescription_tenant_id_checked_by_checked_registration_id_fkey";

ALTER TABLE "prescription" VALIDATE CONSTRAINT "prescription_checked_by_fkey";

ALTER TABLE prescription VALIDATE CONSTRAINT prescription_checked_by_check;
