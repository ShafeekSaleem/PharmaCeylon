-- Operations module 1: the stock foundation.
--
-- 1. `stock_ledger.bucket` separates sellable from quarantined units without taking either off
--    on hand, and `reason_code` records why an exceptional movement happened.
-- 2. `stock_reservation` replaces the transfer_reserve_* ledger rows. Those rows subtracted
--    reserved units from on hand while they were still on the shelf, so a stocktake counted
--    them as a surplus and stock ended up overstated once the transfer shipped.
-- 3. `batch_stock` is the running total per batch that every stock check now reads under a row
--    lock, instead of summing the whole ledger with no lock at all.
-- 4. Indexes for the ledger lookups the app actually makes, and for audit timelines.
-- 5. Permissions: quarantine / release / write-off / cost visibility become their own grants.

-- CreateEnum
CREATE TYPE "StockBucket" AS ENUM ('sellable', 'quarantine');

-- CreateEnum
CREATE TYPE "StockReservationStatus" AS ENUM ('active', 'released', 'consumed');

-- AlterTable
ALTER TABLE "stock_ledger" ADD COLUMN     "bucket" "StockBucket" NOT NULL DEFAULT 'sellable',
ADD COLUMN     "reason_code" VARCHAR(32);

-- AlterTable
ALTER TABLE "tenant_settings" ADD COLUMN     "self_approval_role_keys" TEXT[] DEFAULT ARRAY['owner', 'manager']::TEXT[];

-- CreateTable
CREATE TABLE "batch_stock" (
    "batch_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "on_hand_qty" INTEGER NOT NULL DEFAULT 0,
    "quarantined_qty" INTEGER NOT NULL DEFAULT 0,
    "reserved_qty" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "batch_stock_pkey" PRIMARY KEY ("batch_id")
);

-- CreateTable
CREATE TABLE "stock_reservation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "qty" INTEGER NOT NULL,
    "source_type" VARCHAR(32) NOT NULL,
    "source_id" UUID NOT NULL,
    "source_line_id" UUID,
    "status" "StockReservationStatus" NOT NULL DEFAULT 'active',
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMP(3),
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "stock_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "batch_stock_tenant_id_branch_id_product_id_idx" ON "batch_stock"("tenant_id", "branch_id", "product_id");

-- CreateIndex
CREATE INDEX "stock_reservation_tenant_id_branch_id_batch_id_status_idx" ON "stock_reservation"("tenant_id", "branch_id", "batch_id", "status");

-- CreateIndex
CREATE INDEX "stock_reservation_tenant_id_source_type_source_id_idx" ON "stock_reservation"("tenant_id", "source_type", "source_id");

-- CreateIndex
CREATE INDEX "audit_event_tenant_id_entity_name_entity_id_created_at_idx" ON "audit_event"("tenant_id", "entity_name", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_event_tenant_id_created_at_idx" ON "audit_event"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "stock_ledger_tenant_id_branch_id_batch_id_idx" ON "stock_ledger"("tenant_id", "branch_id", "batch_id");

-- CreateIndex
CREATE INDEX "stock_ledger_tenant_id_branch_id_occurred_at_idx" ON "stock_ledger"("tenant_id", "branch_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "stock_ledger_tenant_id_reference_type_reference_id_idx" ON "stock_ledger"("tenant_id", "reference_type", "reference_id");

-- AddForeignKey
ALTER TABLE "batch_stock" ADD CONSTRAINT "batch_stock_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Backfill 1: open transfer reservations leave the ledger ──────────────────────────────────
-- Every approved (not yet shipped) transfer line holds a reservation.
INSERT INTO "stock_reservation" (
  "id", "tenant_id", "branch_id", "product_id", "batch_id", "qty",
  "source_type", "source_id", "source_line_id", "status", "created_by", "created_at"
)
SELECT gen_random_uuid(), t."tenant_id", t."from_branch_id", ti."product_id", ti."batch_id", ti."qty",
       'transfer', t."id", ti."id", 'active', t."approved_by", t."updated_at"
FROM "transfer" t
JOIN "transfer_item" ti ON ti."transfer_id" = t."id" AND ti."tenant_id" = t."tenant_id"
WHERE t."status" = 'approved'
  AND ti."batch_id" IS NOT NULL
  AND ti."qty" > 0;

-- Whatever reserve movement is still unbalanced in the ledger gets a compensating release, so on
-- hand goes back to what is physically on the shelf. Shipped and cancelled transfers already net
-- to zero and are untouched. The ledger is append-only, so this adds rows rather than deleting.
INSERT INTO "stock_ledger" (
  "id", "tenant_id", "branch_id", "product_id", "batch_id", "movement_type", "qty_delta",
  "bucket", "reference_type", "reference_id", "reason", "occurred_at", "created_by", "created_at"
)
SELECT gen_random_uuid(), l."tenant_id", l."branch_id", l."product_id", l."batch_id",
       'transfer_reserve_release', -SUM(l."qty_delta"), 'sellable', 'transfer', l."reference_id",
       'Reservation moved from the stock ledger to stock reservations', now(), NULL, now()
FROM "stock_ledger" l
WHERE l."reference_type" = 'transfer'
  AND l."movement_type" IN ('transfer_reserve_out', 'transfer_reserve_release')
GROUP BY l."tenant_id", l."branch_id", l."product_id", l."batch_id", l."reference_id"
HAVING SUM(l."qty_delta") <> 0;

-- ── Backfill 2: whole-batch quarantine flags become quarantined quantities ──────────────────
WITH held AS MATERIALIZED (
  SELECT b."id" AS batch_id, b."tenant_id", b."branch_id", b."product_id",
         SUM(l."qty_delta")::int AS on_hand,
         b."quarantine_reason", b."quarantined_at",
         gen_random_uuid() AS ref
  FROM "batch" b
  JOIN "stock_ledger" l ON l."batch_id" = b."id" AND l."tenant_id" = b."tenant_id"
  WHERE b."is_quarantined" = true
  GROUP BY b."id"
  HAVING SUM(l."qty_delta") > 0
)
INSERT INTO "stock_ledger" (
  "id", "tenant_id", "branch_id", "product_id", "batch_id", "movement_type", "qty_delta",
  "bucket", "reference_type", "reference_id", "reason", "reason_code", "occurred_at",
  "created_by", "created_at"
)
SELECT gen_random_uuid(), h."tenant_id", h."branch_id", h."product_id", h.batch_id,
       'quarantine_hold', side.delta, side.bucket::"StockBucket", 'batch_quarantine', h.ref,
       COALESCE(h."quarantine_reason", 'Quarantined'),
       CASE WHEN h."quarantine_reason" = 'Auto-quarantined: expired' THEN 'expired' ELSE 'other' END,
       COALESCE(h."quarantined_at", now()), NULL, now()
FROM held h
CROSS JOIN LATERAL (
  VALUES (-h.on_hand, 'sellable'), (h.on_hand, 'quarantine')
) AS side(delta, bucket);

-- A flag on a batch with nothing left holds nothing back; the audit log keeps the history.
UPDATE "batch" b
SET "is_quarantined" = false, "quarantined_at" = NULL, "quarantine_reason" = NULL
WHERE b."is_quarantined" = true
  AND COALESCE((
    SELECT SUM(l."qty_delta") FROM "stock_ledger" l
    WHERE l."batch_id" = b."id" AND l."tenant_id" = b."tenant_id"
  ), 0) <= 0;

-- ── Backfill 3: batch_stock from the ledger and reservations ────────────────────────────────
INSERT INTO "batch_stock" (
  "batch_id", "tenant_id", "branch_id", "product_id",
  "on_hand_qty", "quarantined_qty", "reserved_qty", "updated_at"
)
SELECT b."id", b."tenant_id", b."branch_id", b."product_id",
       COALESCE(led.on_hand, 0), COALESCE(led.quarantined, 0), COALESCE(res.reserved, 0), now()
FROM "batch" b
LEFT JOIN (
  SELECT "batch_id",
         SUM("qty_delta")::int AS on_hand,
         SUM(CASE WHEN "bucket" = 'quarantine' THEN "qty_delta" ELSE 0 END)::int AS quarantined
  FROM "stock_ledger"
  WHERE "batch_id" IS NOT NULL
  GROUP BY "batch_id"
) led ON led."batch_id" = b."id"
LEFT JOIN (
  SELECT "batch_id", SUM("qty")::int AS reserved
  FROM "stock_reservation"
  WHERE "status" = 'active'
  GROUP BY "batch_id"
) res ON res."batch_id" = b."id";

-- ── Staged tenant policies (disabled, same as every other tenant-owned table) ───────────────
CREATE POLICY "pc_tenant_isolation" ON "batch_stock"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "pc_tenant_isolation" ON "stock_reservation"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ── Permissions ─────────────────────────────────────────────────────────────────────────────
-- `ensureRbacSeed()` only grants catalog defaults when a Role row is first created, so existing
-- tenants get the new keys here (same approach as 20260829090100_backfill_branches_manage_permission).
INSERT INTO "permission" ("key", "module", "label", "description") VALUES
  ('inventory.quarantine', 'inventory', 'Quarantine stock',
   'Hold units back from sale and transfer — expired, damaged, recalled or awaiting inspection.'),
  ('inventory.release_quarantine', 'inventory', 'Release quarantined stock',
   'Return held units to sellable stock after inspection.'),
  ('inventory.write_off', 'inventory', 'Write off stock',
   'Decrease stock on a batch: damage, loss, expiry write-off or a negative correction.'),
  ('inventory.view_cost', 'inventory', 'View cost and stock value',
   'Batch cost prices and stock valuation in Inventory.')
ON CONFLICT ("key") DO NOTHING;

-- Quarantine was part of `inventory.manage`; every role that could do it keeps it, and the
-- built-in pharmacist role gains it (the pharmacist is usually the one who spots a bad lot).
INSERT INTO "role_permission" ("id", "tenant_id", "role_id", "permission_key")
SELECT gen_random_uuid(), r."tenant_id", r."id", 'inventory.quarantine'
FROM "role" r
WHERE (r."is_system" = true AND r."key" IN ('owner', 'manager', 'pharmacist', 'inventory_clerk'))
   OR EXISTS (
     SELECT 1 FROM "role_permission" rp
     WHERE rp."role_id" = r."id" AND rp."permission_key" = 'inventory.manage'
   )
ON CONFLICT ("role_id", "permission_key") DO NOTHING;

-- Releasing is a quality decision: built-in owner, manager and pharmacist. Custom roles that
-- could release through `inventory.manage` keep that ability until an admin decides otherwise.
INSERT INTO "role_permission" ("id", "tenant_id", "role_id", "permission_key")
SELECT gen_random_uuid(), r."tenant_id", r."id", 'inventory.release_quarantine'
FROM "role" r
WHERE (r."is_system" = true AND r."key" IN ('owner', 'manager', 'pharmacist'))
   OR (r."is_system" = false AND EXISTS (
     SELECT 1 FROM "role_permission" rp
     WHERE rp."role_id" = r."id" AND rp."permission_key" = 'inventory.manage'
   ))
ON CONFLICT ("role_id", "permission_key") DO NOTHING;

-- Decreases were hardcoded to owner/manager; that is exactly who gets the grant.
INSERT INTO "role_permission" ("id", "tenant_id", "role_id", "permission_key")
SELECT gen_random_uuid(), r."tenant_id", r."id", 'inventory.write_off'
FROM "role" r
WHERE r."is_system" = true AND r."key" IN ('owner', 'manager')
ON CONFLICT ("role_id", "permission_key") DO NOTHING;

INSERT INTO "role_permission" ("id", "tenant_id", "role_id", "permission_key")
SELECT gen_random_uuid(), r."tenant_id", r."id", 'inventory.view_cost'
FROM "role" r
WHERE r."is_system" = true AND r."key" IN ('owner', 'manager')
ON CONFLICT ("role_id", "permission_key") DO NOTHING;

-- The counter customer-return endpoint it guarded answers 410 Gone and has been removed;
-- customer returns go through POS refunds.
DELETE FROM "role_permission" WHERE "permission_key" = 'inventory.customer_returns';
DELETE FROM "permission" WHERE "key" = 'inventory.customer_returns';
