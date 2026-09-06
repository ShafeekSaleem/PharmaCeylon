-- Phase 5 onboarding: explicit tenant membership plus secure staff invitations.

CREATE TABLE "tenant_membership" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tenant_membership_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "app_user" ADD COLUMN "last_tenant_id" UUID;
UPDATE "app_user" SET "last_tenant_id" = "tenant_id";

DROP INDEX IF EXISTS "notification_preference_user_id_key";
CREATE UNIQUE INDEX "notification_preference_tenant_id_user_id_key"
  ON "notification_preference"("tenant_id", "user_id");
DROP INDEX IF EXISTS "dashboard_layout_user_id_key";
CREATE UNIQUE INDEX "dashboard_layout_tenant_id_user_id_key"
  ON "dashboard_layout"("tenant_id", "user_id");

-- Every existing tenant-scoped account becomes an active membership. The
-- historical app_user.tenant_id remains the home tenant while application
-- authorization moves to this relation.
INSERT INTO "tenant_membership" ("id", "tenant_id", "user_id", "is_active", "joined_at", "updated_at")
SELECT gen_random_uuid(), "tenant_id", "id", "is_active", "created_at", CURRENT_TIMESTAMP
FROM "app_user";

CREATE UNIQUE INDEX "tenant_membership_tenant_id_user_id_key"
  ON "tenant_membership"("tenant_id", "user_id");
CREATE INDEX "tenant_membership_user_id_is_active_idx"
  ON "tenant_membership"("user_id", "is_active");

ALTER TABLE "tenant_membership"
  ADD CONSTRAINT "tenant_membership_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_membership"
  ADD CONSTRAINT "tenant_membership_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "staff_invitation" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "email" TEXT NOT NULL,
  "full_name" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "accepted_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "invited_by_user_id" UUID NOT NULL,
  "accepted_user_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "staff_invitation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "staff_invitation_branch_role" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "invitation_id" UUID NOT NULL,
  "branch_id" UUID NOT NULL,
  "role" "RoleName" NOT NULL,
  "role_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "staff_invitation_branch_role_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "staff_invitation_token_hash_key" ON "staff_invitation"("token_hash");
CREATE INDEX "staff_invitation_tenant_id_email_accepted_at_revoked_at_idx"
  ON "staff_invitation"("tenant_id", "email", "accepted_at", "revoked_at");
CREATE INDEX "staff_invitation_expires_at_idx" ON "staff_invitation"("expires_at");
-- Only one live invitation per email and tenant. Expired rows are revoked by
-- resend before a replacement is created.
CREATE UNIQUE INDEX "staff_invitation_one_pending_per_email"
  ON "staff_invitation"("tenant_id", lower("email"))
  WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;

CREATE UNIQUE INDEX "staff_invitation_branch_role_invitation_id_branch_id_role_key"
  ON "staff_invitation_branch_role"("invitation_id", "branch_id", "role");
CREATE INDEX "staff_invitation_branch_role_tenant_id_branch_id_idx"
  ON "staff_invitation_branch_role"("tenant_id", "branch_id");

ALTER TABLE "staff_invitation"
  ADD CONSTRAINT "staff_invitation_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_invitation"
  ADD CONSTRAINT "staff_invitation_invited_by_user_id_fkey"
  FOREIGN KEY ("invited_by_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "staff_invitation"
  ADD CONSTRAINT "staff_invitation_accepted_user_id_fkey"
  FOREIGN KEY ("accepted_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "staff_invitation_branch_role"
  ADD CONSTRAINT "staff_invitation_branch_role_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_invitation_branch_role"
  ADD CONSTRAINT "staff_invitation_branch_role_invitation_id_fkey"
  FOREIGN KEY ("invitation_id") REFERENCES "staff_invitation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_invitation_branch_role"
  ADD CONSTRAINT "staff_invitation_branch_role_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_invitation_branch_role"
  ADD CONSTRAINT "staff_invitation_branch_role_role_id_fkey"
  FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Policies are staged consistently with the rest of the schema. RLS remains
-- disabled until the existing rollout runbook enables it.
CREATE POLICY "pc_tenant_isolation" ON "tenant_membership"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "pc_tenant_isolation" ON "staff_invitation"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "pc_tenant_isolation" ON "staff_invitation_branch_role"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON POLICY "pc_tenant_isolation" ON "tenant_membership" IS
  'Phase 5 staged tenant policy; RLS remains disabled pending staged rollout.';
COMMENT ON POLICY "pc_tenant_isolation" ON "staff_invitation" IS
  'Phase 5 staged tenant policy; RLS remains disabled pending staged rollout.';
COMMENT ON POLICY "pc_tenant_isolation" ON "staff_invitation_branch_role" IS
  'Phase 5 staged tenant policy; RLS remains disabled pending staged rollout.';
