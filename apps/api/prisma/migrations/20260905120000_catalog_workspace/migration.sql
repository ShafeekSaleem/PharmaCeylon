-- Catalog Management workspace: a durable work queue, real referential integrity on the
-- register-link history, and enough import state in the database that a restart can't leave a
-- job "running" forever.
--
-- Additive throughout. The one place existing rows are touched is the pre-clean below, which
-- only runs against `product_nmra_link` rows that are *already* broken (their reference row is
-- gone), and writes an audit event for each before removing it.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Catalog task enums
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "CatalogTaskType" AS ENUM ('MISSING_CATEGORY', 'NMRA_MATCH', 'NMRA_AMBIGUOUS', 'IMPORT_DUPLICATE');

-- CreateEnum
CREATE TYPE "CatalogTaskStatus" AS ENUM ('OPEN', 'NEEDS_REVIEW', 'RESOLVED', 'DISMISSED', 'NOT_APPLICABLE');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. product_import: durable progress + heartbeat
--    Nullable / defaulted so existing rows need no backfill. Historical imports keep
--    rows_processed = rows_total = 0; they are already `completed`, and nothing reads
--    progress off a finished import.
-- ─────────────────────────────────────────────────────────────────────────────

-- AlterTable
ALTER TABLE "product_import" ADD COLUMN "phase" VARCHAR(32);
ALTER TABLE "product_import" ADD COLUMN "rows_processed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "product_import" ADD COLUMN "rows_total" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "product_import" ADD COLUMN "heartbeat_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "product_import_status_heartbeat_at_idx" ON "product_import"("status", "heartbeat_at");

-- Any import left `running` by a restart *before* this migration can never be resumed and
-- must not sit there forever. Move it to the recoverable terminal state now, so the sweep in
-- ImportJobRunner starts from a clean slate.
UPDATE "product_import"
   SET "status" = 'failed',
       "error" = COALESCE("error", 'Interrupted before the durable job runner existed. Products already created were kept — re-run the import for the remaining rows.'),
       "completed_at" = COALESCE("completed_at", NOW())
 WHERE "status" = 'running';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. product_nmra_link: real foreign keys
--
--    `reference_product_id` has never had one. Deleting a reference product nulled
--    `product.nmra_reference_id` (that FK is ON DELETE SET NULL) but left this row pointing at
--    a row that no longer exists — stale undo history describing a restore that can no longer
--    be performed. Clean those, then constrain so it can't recur.
-- ─────────────────────────────────────────────────────────────────────────────

-- Preserve what is about to be removed as audit history, so the trail survives the cleanup.
INSERT INTO "audit_event" ("id", "tenant_id", "actor_user_id", "event_name", "entity_name", "entity_id", "payload", "created_at")
SELECT gen_random_uuid(),
       l."tenant_id",
       NULL,
       'products.nmra_link_history_pruned',
       'product',
       l."product_id",
       jsonb_build_object(
         'reason', 'Reference product no longer exists; link-history row could not satisfy the new foreign key.',
         'referenceProductId', l."reference_product_id",
         'adoptedFields', l."adopted_fields",
         'previousValues', l."previous_values",
         'linkedAt', l."linked_at",
         'migration', '20260905120000_catalog_workspace'
       ),
       NOW()
  FROM "product_nmra_link" l
 WHERE NOT EXISTS (SELECT 1 FROM "product" p WHERE p."id" = l."reference_product_id");

DELETE FROM "product_nmra_link" l
 WHERE NOT EXISTS (SELECT 1 FROM "product" p WHERE p."id" = l."reference_product_id");

-- `linked_by_user_id` is nullable and becomes ON DELETE SET NULL; null out any id that no
-- longer resolves so the constraint can be added.
UPDATE "product_nmra_link" l
   SET "linked_by_user_id" = NULL
 WHERE l."linked_by_user_id" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "app_user" u WHERE u."id" = l."linked_by_user_id");

-- AddForeignKey
ALTER TABLE "product_nmra_link" ADD CONSTRAINT "product_nmra_link_reference_product_id_fkey" FOREIGN KEY ("reference_product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_nmra_link" ADD CONSTRAINT "product_nmra_link_linked_by_user_id_fkey" FOREIGN KEY ("linked_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. catalog_task
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "catalog_task" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "type" "CatalogTaskType" NOT NULL,
    "status" "CatalogTaskStatus" NOT NULL DEFAULT 'OPEN',
    "suggestion" JSONB,
    "evidence" VARCHAR(32),
    "confidence" DECIMAL(4,3),
    "compliance_impact" BOOLEAN NOT NULL DEFAULT false,
    "safe_to_apply" BOOLEAN NOT NULL DEFAULT false,
    "candidates" JSONB,
    "import_id" UUID,
    "source_row" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "resolved_by_user_id" UUID,
    "resolution_note" TEXT,

    CONSTRAINT "catalog_task_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "catalog_task_tenant_id_product_id_type_key" ON "catalog_task"("tenant_id", "product_id", "type");

-- CreateIndex
CREATE INDEX "catalog_task_tenant_id_status_type_idx" ON "catalog_task"("tenant_id", "status", "type");

-- CreateIndex
CREATE INDEX "catalog_task_tenant_id_status_created_at_idx" ON "catalog_task"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "catalog_task_tenant_id_import_id_idx" ON "catalog_task"("tenant_id", "import_id");

-- CreateIndex
CREATE INDEX "catalog_task_tenant_id_status_safe_to_apply_idx" ON "catalog_task"("tenant_id", "status", "safe_to_apply");

-- AddForeignKey
ALTER TABLE "catalog_task" ADD CONSTRAINT "catalog_task_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_task" ADD CONSTRAINT "catalog_task_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_task" ADD CONSTRAINT "catalog_task_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "product_import"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Matching-index support
--
--    The matcher used to load up to 5,000 reference rows into memory and index them there,
--    which silently excluded everything past that cap on a 15,000-row register. It now issues
--    bounded, indexed candidate queries per product instead. These indexes are what make that
--    cheap: case-insensitive lookups on the three identifier columns it probes.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS "product_tenant_lower_name_idx" ON "product"("tenant_id", LOWER("name"));
CREATE INDEX IF NOT EXISTS "product_tenant_lower_barcode_idx" ON "product"("tenant_id", LOWER("barcode"));
CREATE INDEX IF NOT EXISTS "product_tenant_lower_registration_no_idx" ON "product"("tenant_id", LOWER("registration_no"));
CREATE INDEX IF NOT EXISTS "product_tenant_lower_generic_name_idx" ON "product"("tenant_id", LOWER("generic_name"));
