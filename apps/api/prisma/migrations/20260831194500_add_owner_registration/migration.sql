-- CreateEnum
CREATE TYPE "OwnerRegistrationStatus" AS ENUM (
  'pending_email',
  'verified',
  'expired',
  'completed',
  'cancelled'
);

-- CreateTable
CREATE TABLE "owner_registration" (
  "id" UUID NOT NULL,
  "email" TEXT NOT NULL,
  "first_name" TEXT NOT NULL,
  "last_name" TEXT NOT NULL,
  "phone" TEXT,
  "password_hash" TEXT NOT NULL,
  "status" "OwnerRegistrationStatus" NOT NULL DEFAULT 'pending_email',
  "verification_token_hash" TEXT,
  "verification_expires_at" TIMESTAMP(3),
  "verified_at" TIMESTAMP(3),
  "onboarding_session_version" INTEGER NOT NULL DEFAULT 0,
  "onboarding_draft" JSONB,
  "completed_tenant_id" UUID,
  "completed_user_id" UUID,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "owner_registration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "owner_registration_email_key"
ON "owner_registration"("email");

CREATE UNIQUE INDEX "owner_registration_verification_token_hash_key"
ON "owner_registration"("verification_token_hash");

CREATE INDEX "owner_registration_status_verification_expires_at_idx"
ON "owner_registration"("status", "verification_expires_at");
