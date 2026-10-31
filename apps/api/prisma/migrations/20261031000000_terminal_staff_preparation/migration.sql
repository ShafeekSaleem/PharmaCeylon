-- D-W5: one personal PIN per person, prepared on each counter by entering it there while online.
-- The version lets a counter and a future offline grant tell a current preparation from a stale one.
ALTER TABLE "app_user" ADD COLUMN "pos_pin_version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "app_user" ADD CONSTRAINT app_user_pos_pin_version_check CHECK (pos_pin_version >= 0);

CREATE TABLE "terminal_staff_preparation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "terminal_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "key_id" VARCHAR(128) NOT NULL,
    "staff_user_id" UUID NOT NULL,
    "pin_version" INTEGER NOT NULL,
    "prepared_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "terminal_staff_preparation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "terminal_staff_preparation_tenant_id_enrollment_id_staff_user_id_key" ON "terminal_staff_preparation"("tenant_id", "enrollment_id", "staff_user_id");
CREATE INDEX "terminal_staff_preparation_tenant_id_staff_user_id_idx" ON "terminal_staff_preparation"("tenant_id", "staff_user_id");

ALTER TABLE "terminal_staff_preparation" ADD CONSTRAINT "terminal_staff_preparation_tenant_id_branch_id_terminal_id_fkey" FOREIGN KEY ("tenant_id", "branch_id", "terminal_id", "enrollment_id", "key_id") REFERENCES "terminal_enrollment"("tenant_id", "branch_id", "terminal_id", "id", "key_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "terminal_staff_preparation" ADD CONSTRAINT "terminal_staff_preparation_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE terminal_staff_preparation ADD CONSTRAINT terminal_staff_preparation_version_check CHECK (pin_version > 0);

CREATE POLICY pc_tenant_isolation ON terminal_staff_preparation
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- RLS remains disabled, consistent with the staged inventory.
