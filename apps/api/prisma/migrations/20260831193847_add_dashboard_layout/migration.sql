-- CreateTable
CREATE TABLE "dashboard_layout" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "widgets" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboard_layout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_layout_user_id_key" ON "dashboard_layout"("user_id");

-- CreateIndex
CREATE INDEX "dashboard_layout_tenant_id_idx" ON "dashboard_layout"("tenant_id");

-- AddForeignKey
ALTER TABLE "dashboard_layout" ADD CONSTRAINT "dashboard_layout_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_layout" ADD CONSTRAINT "dashboard_layout_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "notification_tenant_id_recipient_user_id_archived_at_resolved_a" RENAME TO "notification_tenant_id_recipient_user_id_archived_at_resolv_idx";
