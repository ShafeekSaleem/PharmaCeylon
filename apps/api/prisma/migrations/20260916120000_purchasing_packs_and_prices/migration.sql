-- Module 2a: buying in packs, deliveries that match what arrived, and a supplier price list.
--
-- Everything here is additive. Quantities stay in units everywhere they already were, so
-- existing orders, receipts, reports and the stock ledger keep their meaning.

-- ── Products: a pack you can calculate with ────────────────────────────────────────────────
-- `pack_size` is the NMRA register's descriptive text ("10x10 tablets"); it cannot be divided
-- by. `units_per_pack` is the buying unit, and defaults to 1 so nothing changes until a
-- pharmacy sets it.
ALTER TABLE "product"
  ADD COLUMN "units_per_pack" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "pack_label" TEXT;

-- ── Purchase order lines: packs as ordered, and receipt totals on the line ─────────────────
ALTER TABLE "purchase_order_item"
  ADD COLUMN "ordered_packs" INTEGER,
  ADD COLUMN "units_per_pack" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "pack_cost" DECIMAL(12, 2),
  ADD COLUMN "received_qty" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "free_qty" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "rejected_qty" INTEGER NOT NULL DEFAULT 0;

-- ── Goods receipt lines: free goods, rejects, and what was actually billed ─────────────────
ALTER TABLE "goods_receipt_item"
  ADD COLUMN "free_qty" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "rejected_qty" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "packs" INTEGER,
  ADD COLUMN "unit_cost" DECIMAL(12, 2);

-- Historic receipts were valued at the batch's cost price, because that is the only cost the
-- old form recorded. Backfilling it makes "what did this delivery cost" answerable for orders
-- placed before today without inventing a number.
UPDATE "goods_receipt_item" gri
SET "unit_cost" = b."cost_price"
FROM "batch" b
WHERE b."id" = gri."batch_id"
  AND gri."unit_cost" IS NULL;

-- Every delivery already posted counts towards its order line. Receiving used to re-sum the
-- receipts on each posting; from here the line carries the running total, so it has to start
-- out agreeing with history.
UPDATE "purchase_order_item" poi
SET "received_qty" = COALESCE(agg."qty", 0)
FROM (
  SELECT gr."purchase_order_id", gri."product_id", SUM(gri."received_qty")::int AS "qty"
  FROM "goods_receipt_item" gri
  JOIN "goods_receipt" gr ON gr."id" = gri."goods_receipt_id"
  GROUP BY gr."purchase_order_id", gri."product_id"
) agg
WHERE agg."purchase_order_id" = poi."purchase_order_id"
  AND agg."product_id" = poi."product_id";

-- ── Over-delivery tolerance ────────────────────────────────────────────────────────────────
ALTER TABLE "tenant_settings"
  ADD COLUMN "goods_receipt_over_tolerance_percent" DECIMAL(5, 2) NOT NULL DEFAULT 0;

-- ── Supplier price list ────────────────────────────────────────────────────────────────────
CREATE TABLE "supplier_product_price" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "supplier_id" UUID NOT NULL,
  "product_id" UUID NOT NULL,
  "supplier_sku" TEXT,
  "units_per_pack" INTEGER NOT NULL DEFAULT 1,
  "pack_cost" DECIMAL(12, 2),
  "unit_cost" DECIMAL(12, 2) NOT NULL,
  "discount_percent" DECIMAL(5, 2) NOT NULL DEFAULT 0,
  "last_unit_cost" DECIMAL(12, 2),
  "last_purchased_at" TIMESTAMP(3),
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "supplier_product_price_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "supplier_product_price_tenant_id_supplier_id_product_id_key"
  ON "supplier_product_price" ("tenant_id", "supplier_id", "product_id");
CREATE INDEX "supplier_product_price_tenant_id_product_id_idx"
  ON "supplier_product_price" ("tenant_id", "product_id");

ALTER TABLE "supplier_product_price"
  ADD CONSTRAINT "supplier_product_price_supplier_id_fkey"
  FOREIGN KEY ("supplier_id") REFERENCES "supplier" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "supplier_product_price"
  ADD CONSTRAINT "supplier_product_price_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "product" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the list from what each supplier was last paid, so it is useful on day one instead of
-- being an empty screen somebody has to fill in. Only batches that recorded a supplier count;
-- the agreed cost starts as the last cost paid and a buyer can correct it.
INSERT INTO "supplier_product_price" (
  "id", "tenant_id", "supplier_id", "product_id", "units_per_pack",
  "unit_cost", "last_unit_cost", "last_purchased_at", "created_at", "updated_at"
)
SELECT
  gen_random_uuid(), b."tenant_id", b."supplier_id", b."product_id", 1,
  b."cost_price", b."cost_price", b."received_at", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT ON (t."tenant_id", t."supplier_id", t."product_id")
    t."tenant_id", t."supplier_id", t."product_id", t."cost_price", t."received_at"
  FROM "batch" t
  WHERE t."supplier_id" IS NOT NULL
  ORDER BY t."tenant_id", t."supplier_id", t."product_id", t."received_at" DESC
) b
ON CONFLICT ("tenant_id", "supplier_id", "product_id") DO NOTHING;

-- ── Staged tenant policies (disabled, same as every other tenant-owned table) ──────────────
CREATE POLICY "pc_tenant_isolation" ON "supplier_product_price"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ── Permissions ────────────────────────────────────────────────────────────────────────────
INSERT INTO "permission" ("key", "module", "label", "description") VALUES
  ('purchasing.receive', 'purchasing', 'Receive deliveries',
   'Book goods in against a purchase order, including free goods and damaged units.'),
  ('purchasing.view_cost', 'purchasing', 'View purchase costs',
   'Unit costs, order values and supplier price lists in Purchasing.')
ON CONFLICT ("key") DO NOTHING;

-- Receiving was part of `purchasing.manage`; everyone who could receive keeps the ability, so
-- splitting the permission takes nothing away from anyone.
INSERT INTO "role_permission" ("id", "tenant_id", "role_id", "permission_key")
SELECT gen_random_uuid(), r."tenant_id", r."id", 'purchasing.receive'
FROM "role" r
WHERE (r."is_system" = true AND r."key" IN ('owner', 'manager', 'inventory_clerk'))
   OR EXISTS (
     SELECT 1 FROM "role_permission" rp
     WHERE rp."role_id" = r."id" AND rp."permission_key" = 'purchasing.manage'
   )
ON CONFLICT ("role_id", "permission_key") DO NOTHING;

-- Costs were visible to anyone with `purchasing.view`, which includes pharmacists and any
-- custom role given read access to orders. Granting the new key to exactly those roles keeps
-- today's behaviour; an owner can now take it away, which they could not before.
INSERT INTO "role_permission" ("id", "tenant_id", "role_id", "permission_key")
SELECT gen_random_uuid(), r."tenant_id", r."id", 'purchasing.view_cost'
FROM "role" r
WHERE (r."is_system" = true AND r."key" IN ('owner', 'manager', 'inventory_clerk', 'pharmacist'))
   OR EXISTS (
     SELECT 1 FROM "role_permission" rp
     WHERE rp."role_id" = r."id" AND rp."permission_key" = 'purchasing.view'
   )
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
