-- Stock ledger: reverse sale stock for void/refund flows
ALTER TYPE "StockMovementType" ADD VALUE 'sale_void_in';
ALTER TYPE "StockMovementType" ADD VALUE 'sale_refund_in';

CREATE TABLE "idempotency_record" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "scope" VARCHAR(64) NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "resource_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_record_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "idempotency_record_tenant_id_user_id_scope_idempotency_key_key" ON "idempotency_record"("tenant_id", "user_id", "scope", "idempotency_key");

CREATE INDEX "idempotency_record_tenant_id_scope_resource_id_idx" ON "idempotency_record"("tenant_id", "scope", "resource_id");
