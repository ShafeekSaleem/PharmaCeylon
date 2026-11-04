CREATE TABLE "offline_authority_issuance" (
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "command_id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "grant" JSONB NOT NULL,
    CONSTRAINT "offline_authority_issuance_pkey"
        PRIMARY KEY ("tenant_id", "branch_id", "enrollment_id", "command_id")
);

CREATE UNIQUE INDEX "offline_authority_issuance_snapshot_id_key"
ON "offline_authority_issuance" ("snapshot_id");
