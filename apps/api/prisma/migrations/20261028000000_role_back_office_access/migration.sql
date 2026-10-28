ALTER TABLE "role" ADD COLUMN "back_office_access" BOOLEAN NOT NULL DEFAULT true;
UPDATE "role" SET "back_office_access" = false WHERE "is_system" = true AND "key" = 'cashier';
ALTER TABLE "role" ADD CONSTRAINT "role_owner_back_office_access" CHECK ("key" <> 'owner' OR "back_office_access" = true);
