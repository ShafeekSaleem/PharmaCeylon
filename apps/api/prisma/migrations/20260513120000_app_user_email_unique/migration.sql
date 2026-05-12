-- One login identity per email across the whole system (tenant derived from the user row).
DROP INDEX IF EXISTS "app_user_tenant_id_email_key";

CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");
