ALTER TABLE "tenant"
  ADD COLUMN "logo_url" TEXT,
  ADD COLUMN "address_line1" TEXT,
  ADD COLUMN "address_line2" TEXT,
  ADD COLUMN "city" TEXT,
  ADD COLUMN "postal_code" TEXT,
  ADD COLUMN "email" TEXT,
  ADD COLUMN "phone" TEXT,
  ADD COLUMN "tax_identification_no" TEXT,
  ADD COLUMN "vat_registration_no" TEXT;

ALTER TABLE "branch"
  ADD COLUMN "address_line2" TEXT,
  ADD COLUMN "district" TEXT,
  ADD COLUMN "postal_code" TEXT,
  ADD COLUMN "email" TEXT,
  ADD COLUMN "pharmacy_licence_no" TEXT,
  ADD COLUMN "pharmacy_licence_expiry" DATE,
  ADD COLUMN "responsible_pharmacist" TEXT,
  ADD COLUMN "pharmacist_slmc_no" TEXT,
  ADD COLUMN "opening_hours" TEXT;
