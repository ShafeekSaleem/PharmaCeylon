CREATE TABLE "offline_stock_snapshot" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL,
    "envelope" JSONB NOT NULL,
    CONSTRAINT "offline_stock_snapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "offline_stock_snapshot_positive_version" CHECK ("version" > 0)
);

CREATE UNIQUE INDEX "offline_stock_snapshot_enrollment_version_key"
ON "offline_stock_snapshot" ("tenant_id", "branch_id", "enrollment_id", "version");
