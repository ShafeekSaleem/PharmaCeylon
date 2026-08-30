CREATE TYPE "NotificationCategory" AS ENUM (
  'inventory',
  'expiry',
  'purchasing',
  'transfers',
  'stocktakes',
  'sales',
  'compliance',
  'system'
);

CREATE TYPE "NotificationSeverity" AS ENUM ('info', 'warning', 'critical');

CREATE TABLE "notification" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "branch_id" UUID,
  "recipient_user_id" UUID NOT NULL,
  "category" "NotificationCategory" NOT NULL,
  "severity" "NotificationSeverity" NOT NULL DEFAULT 'info',
  "title" VARCHAR(180) NOT NULL,
  "message" VARCHAR(600),
  "action_label" VARCHAR(80),
  "action_href" VARCHAR(500),
  "entity_type" VARCHAR(80),
  "entity_id" UUID,
  "dedupe_key" VARCHAR(240) NOT NULL,
  "source" VARCHAR(80) NOT NULL DEFAULT 'domain_event',
  "metadata" JSONB,
  "requires_action" BOOLEAN NOT NULL DEFAULT false,
  "read_at" TIMESTAMP(3),
  "archived_at" TIMESTAMP(3),
  "resolved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notification_preference" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "inventory_enabled" BOOLEAN NOT NULL DEFAULT true,
  "expiry_enabled" BOOLEAN NOT NULL DEFAULT true,
  "purchasing_enabled" BOOLEAN NOT NULL DEFAULT true,
  "transfers_enabled" BOOLEAN NOT NULL DEFAULT true,
  "stocktakes_enabled" BOOLEAN NOT NULL DEFAULT true,
  "sales_enabled" BOOLEAN NOT NULL DEFAULT true,
  "compliance_enabled" BOOLEAN NOT NULL DEFAULT true,
  "system_enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_tenant_id_recipient_user_id_dedupe_key_key"
  ON "notification"("tenant_id", "recipient_user_id", "dedupe_key");
CREATE INDEX "notification_tenant_id_recipient_user_id_archived_at_resolved_at_created_at_idx"
  ON "notification"("tenant_id", "recipient_user_id", "archived_at", "resolved_at", "created_at" DESC);
CREATE INDEX "notification_tenant_id_recipient_user_id_read_at_idx"
  ON "notification"("tenant_id", "recipient_user_id", "read_at");
CREATE INDEX "notification_tenant_id_branch_id_category_idx"
  ON "notification"("tenant_id", "branch_id", "category");

CREATE UNIQUE INDEX "notification_preference_user_id_key"
  ON "notification_preference"("user_id");
CREATE INDEX "notification_preference_tenant_id_idx"
  ON "notification_preference"("tenant_id");

ALTER TABLE "notification"
  ADD CONSTRAINT "notification_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification"
  ADD CONSTRAINT "notification_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification"
  ADD CONSTRAINT "notification_recipient_user_id_fkey"
  FOREIGN KEY ("recipient_user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_preference"
  ADD CONSTRAINT "notification_preference_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_preference"
  ADD CONSTRAINT "notification_preference_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
