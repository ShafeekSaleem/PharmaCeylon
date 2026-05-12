-- Drop the now-deprecated single-slot refresh hash on app_user
ALTER TABLE "app_user" DROP COLUMN "refresh_token_hash";

-- Add token_version for stateless invalidation of access tokens
ALTER TABLE "app_user" ADD COLUMN "token_version" INTEGER NOT NULL DEFAULT 0;

-- Create session table for refresh-token rotation + reuse detection
CREATE TABLE "session" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,
    "replaced_by_id" UUID,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "session_replaced_by_id_key" ON "session"("replaced_by_id");
CREATE INDEX "session_user_id_idx" ON "session"("user_id");
CREATE INDEX "session_family_id_idx" ON "session"("family_id");
CREATE INDEX "session_expires_at_idx" ON "session"("expires_at");

ALTER TABLE "session"
    ADD CONSTRAINT "session_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "app_user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "session"
    ADD CONSTRAINT "session_replaced_by_id_fkey"
    FOREIGN KEY ("replaced_by_id") REFERENCES "session"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
