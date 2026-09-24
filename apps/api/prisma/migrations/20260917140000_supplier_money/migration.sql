-- Module 2b: the supplier's own invoice, a payment ledger, and debit notes.
--
-- Before this, "the invoice" was a row the system wrote for itself when a delivery was booked
-- in, valued at cost × quantity, and "a payment" was a number added to it with a note appended
-- to a free-text field. Nothing recorded what the supplier actually billed, what was paid when,
-- by what means, or what a return was owed back.

-- ── Supplier: what an invoice and a payment need ───────────────────────────────────────────
ALTER TABLE "supplier"
  ADD COLUMN "address_line" TEXT,
  ADD COLUMN "city" TEXT,
  ADD COLUMN "tax_registration_no" TEXT,
  ADD COLUMN "bank_name" TEXT,
  ADD COLUMN "bank_account_name" TEXT,
  ADD COLUMN "bank_account_no" TEXT;

-- ── Invoice ────────────────────────────────────────────────────────────────────────────────
CREATE TYPE "SupplierInvoiceSource" AS ENUM ('system', 'supplier');
CREATE TYPE "SupplierDebitNoteStatus" AS ENUM ('open', 'settled', 'voided');

ALTER TABLE "supplier_invoice"
  ADD COLUMN "source" "SupplierInvoiceSource" NOT NULL DEFAULT 'system',
  ADD COLUMN "subtotal_amount" DECIMAL(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN "tax_amount" DECIMAL(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN "shipping_amount" DECIMAL(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN "created_by" UUID;

-- Every invoice that exists today was generated from a delivery at cost × quantity, so the
-- goods total is the whole total: no tax or shipping was ever recorded on them.
UPDATE "supplier_invoice" SET "subtotal_amount" = "total_amount" WHERE "subtotal_amount" = 0;

CREATE TABLE "supplier_invoice_line" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "invoice_id" UUID NOT NULL,
  "product_id" UUID,
  "description" TEXT,
  "qty" INTEGER NOT NULL,
  "unit_cost" DECIMAL(12, 2) NOT NULL,
  "discount_percent" DECIMAL(5, 2) NOT NULL DEFAULT 0,
  "tax_percent" DECIMAL(5, 2) NOT NULL DEFAULT 0,
  "line_total" DECIMAL(14, 2) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_invoice_line_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "supplier_invoice_line_tenant_id_invoice_id_idx"
  ON "supplier_invoice_line" ("tenant_id", "invoice_id");
ALTER TABLE "supplier_invoice_line"
  ADD CONSTRAINT "supplier_invoice_line_invoice_id_fkey" FOREIGN KEY ("invoice_id")
  REFERENCES "supplier_invoice" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_invoice_line_product_id_fkey" FOREIGN KEY ("product_id")
  REFERENCES "product" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "supplier_invoice_receipt" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "invoice_id" UUID NOT NULL,
  "goods_receipt_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_invoice_receipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "supplier_invoice_receipt_invoice_id_goods_receipt_id_key"
  ON "supplier_invoice_receipt" ("invoice_id", "goods_receipt_id");
CREATE INDEX "supplier_invoice_receipt_tenant_id_goods_receipt_id_idx"
  ON "supplier_invoice_receipt" ("tenant_id", "goods_receipt_id");
ALTER TABLE "supplier_invoice_receipt"
  ADD CONSTRAINT "supplier_invoice_receipt_invoice_id_fkey" FOREIGN KEY ("invoice_id")
  REFERENCES "supplier_invoice" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_invoice_receipt_goods_receipt_id_fkey" FOREIGN KEY ("goods_receipt_id")
  REFERENCES "goods_receipt" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The one-to-one link every existing invoice already has becomes a link row, so the new
-- many-to-many is the only thing anything has to read.
INSERT INTO "supplier_invoice_receipt" ("id", "tenant_id", "invoice_id", "goods_receipt_id", "created_at")
SELECT gen_random_uuid(), si."tenant_id", si."id", si."goods_receipt_id", si."created_at"
FROM "supplier_invoice" si
WHERE si."goods_receipt_id" IS NOT NULL
ON CONFLICT DO NOTHING;

-- Lines for those system invoices, from what the delivery actually contained. Free units are
-- excluded because nobody was billed for them; rejected units are included because they were.
INSERT INTO "supplier_invoice_line" (
  "id", "tenant_id", "invoice_id", "product_id", "qty", "unit_cost", "line_total", "created_at"
)
SELECT
  gen_random_uuid(), si."tenant_id", si."id", gri."product_id",
  (gri."received_qty" + gri."rejected_qty"),
  COALESCE(gri."unit_cost", b."cost_price"),
  COALESCE(gri."unit_cost", b."cost_price") * (gri."received_qty" + gri."rejected_qty"),
  si."created_at"
FROM "supplier_invoice" si
JOIN "goods_receipt_item" gri ON gri."goods_receipt_id" = si."goods_receipt_id"
JOIN "batch" b ON b."id" = gri."batch_id"
WHERE si."goods_receipt_id" IS NOT NULL;

-- ── Payments ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE "supplier_payment" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "supplier_id" UUID NOT NULL,
  "branch_id" UUID,
  "payment_no" TEXT NOT NULL,
  "paid_on" DATE NOT NULL,
  "amount" DECIMAL(14, 2) NOT NULL,
  "method" "PaymentMethod" NOT NULL DEFAULT 'cash',
  "reference" TEXT,
  "notes" TEXT,
  "voided_at" TIMESTAMP(3),
  "voided_by" UUID,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_payment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "supplier_payment_tenant_id_payment_no_key"
  ON "supplier_payment" ("tenant_id", "payment_no");
CREATE INDEX "supplier_payment_tenant_id_supplier_id_idx"
  ON "supplier_payment" ("tenant_id", "supplier_id");
CREATE INDEX "supplier_payment_tenant_id_paid_on_idx"
  ON "supplier_payment" ("tenant_id", "paid_on" DESC);
ALTER TABLE "supplier_payment"
  ADD CONSTRAINT "supplier_payment_supplier_id_fkey" FOREIGN KEY ("supplier_id")
  REFERENCES "supplier" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_payment_branch_id_fkey" FOREIGN KEY ("branch_id")
  REFERENCES "branch" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_payment_created_by_fkey" FOREIGN KEY ("created_by")
  REFERENCES "app_user" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "supplier_payment_allocation" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "payment_id" UUID NOT NULL,
  "invoice_id" UUID NOT NULL,
  "amount" DECIMAL(14, 2) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_payment_allocation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "supplier_payment_allocation_payment_id_invoice_id_key"
  ON "supplier_payment_allocation" ("payment_id", "invoice_id");
CREATE INDEX "supplier_payment_allocation_tenant_id_invoice_id_idx"
  ON "supplier_payment_allocation" ("tenant_id", "invoice_id");
ALTER TABLE "supplier_payment_allocation"
  ADD CONSTRAINT "supplier_payment_allocation_payment_id_fkey" FOREIGN KEY ("payment_id")
  REFERENCES "supplier_payment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_payment_allocation_invoice_id_fkey" FOREIGN KEY ("invoice_id")
  REFERENCES "supplier_invoice" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Money already recorded as paid becomes a real payment, so the ledger adds up from day one
-- and no invoice silently loses its balance. The method is unknown for these, and says so.
WITH paid AS (
  SELECT si."id", si."tenant_id", si."supplier_id", si."branch_id", si."paid_amount",
         si."updated_at", si."invoice_number",
         row_number() OVER (PARTITION BY si."tenant_id" ORDER BY si."updated_at") AS seq
  FROM "supplier_invoice" si
  WHERE si."paid_amount" > 0
), created AS (
  INSERT INTO "supplier_payment" (
    "id", "tenant_id", "supplier_id", "branch_id", "payment_no", "paid_on", "amount",
    "method", "reference", "notes", "created_by", "created_at"
  )
  SELECT
    gen_random_uuid(), p."tenant_id", p."supplier_id", p."branch_id",
    'PAY-LEGACY-' || lpad(p.seq::text, 5, '0'),
    p."updated_at"::date, p."paid_amount", 'cash', NULL,
    'Recorded before payment history was kept — method and date are approximate.',
    (SELECT u."id" FROM "app_user" u WHERE u."tenant_id" = p."tenant_id" ORDER BY u."created_at" LIMIT 1),
    p."updated_at"
  FROM paid p
  WHERE EXISTS (SELECT 1 FROM "app_user" u WHERE u."tenant_id" = p."tenant_id")
  RETURNING "id", "tenant_id", "amount", "paid_on", "payment_no"
)
INSERT INTO "supplier_payment_allocation" ("id", "tenant_id", "payment_id", "invoice_id", "amount", "created_at")
SELECT gen_random_uuid(), c."tenant_id", c."id", p."id", p."paid_amount", CURRENT_TIMESTAMP
FROM created c
JOIN paid p
  ON p."tenant_id" = c."tenant_id"
 AND 'PAY-LEGACY-' || lpad(p.seq::text, 5, '0') = c."payment_no";

-- ── Debit notes ────────────────────────────────────────────────────────────────────────────
CREATE TABLE "supplier_debit_note" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "supplier_id" UUID NOT NULL,
  "branch_id" UUID NOT NULL,
  "debit_no" TEXT NOT NULL,
  "goods_return_id" UUID,
  "issued_on" DATE NOT NULL,
  "amount" DECIMAL(14, 2) NOT NULL,
  "applied_amount" DECIMAL(14, 2) NOT NULL DEFAULT 0,
  "status" "SupplierDebitNoteStatus" NOT NULL DEFAULT 'open',
  "reason" TEXT,
  "notes" TEXT,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "supplier_debit_note_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "supplier_debit_note_tenant_id_debit_no_key"
  ON "supplier_debit_note" ("tenant_id", "debit_no");
CREATE UNIQUE INDEX "supplier_debit_note_goods_return_id_key"
  ON "supplier_debit_note" ("goods_return_id");
CREATE INDEX "supplier_debit_note_tenant_id_supplier_id_status_idx"
  ON "supplier_debit_note" ("tenant_id", "supplier_id", "status");
ALTER TABLE "supplier_debit_note"
  ADD CONSTRAINT "supplier_debit_note_supplier_id_fkey" FOREIGN KEY ("supplier_id")
  REFERENCES "supplier" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_debit_note_branch_id_fkey" FOREIGN KEY ("branch_id")
  REFERENCES "branch" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_debit_note_goods_return_id_fkey" FOREIGN KEY ("goods_return_id")
  REFERENCES "goods_return" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_debit_note_created_by_fkey" FOREIGN KEY ("created_by")
  REFERENCES "app_user" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "supplier_debit_allocation" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "debit_note_id" UUID NOT NULL,
  "invoice_id" UUID NOT NULL,
  "amount" DECIMAL(14, 2) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_debit_allocation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "supplier_debit_allocation_debit_note_id_invoice_id_key"
  ON "supplier_debit_allocation" ("debit_note_id", "invoice_id");
CREATE INDEX "supplier_debit_allocation_tenant_id_invoice_id_idx"
  ON "supplier_debit_allocation" ("tenant_id", "invoice_id");
ALTER TABLE "supplier_debit_allocation"
  ADD CONSTRAINT "supplier_debit_allocation_debit_note_id_fkey" FOREIGN KEY ("debit_note_id")
  REFERENCES "supplier_debit_note" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_debit_allocation_invoice_id_fkey" FOREIGN KEY ("invoice_id")
  REFERENCES "supplier_invoice" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Staged tenant policies (disabled, same as every other tenant-owned table) ──────────────
CREATE POLICY "pc_tenant_isolation" ON "supplier_invoice_line"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "pc_tenant_isolation" ON "supplier_invoice_receipt"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "pc_tenant_isolation" ON "supplier_payment"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "pc_tenant_isolation" ON "supplier_payment_allocation"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "pc_tenant_isolation" ON "supplier_debit_note"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "pc_tenant_isolation" ON "supplier_debit_allocation"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ── Permissions ────────────────────────────────────────────────────────────────────────────
INSERT INTO "permission" ("key", "module", "label", "description") VALUES
  ('purchasing.invoice', 'purchasing', 'Record supplier invoices',
   'Enter the supplier''s own invoice, match it to deliveries, and void one entered in error.'),
  ('suppliers.pay', 'suppliers', 'Record supplier payments',
   'Record money paid to a supplier and allocate it across their invoices.')
ON CONFLICT ("key") DO NOTHING;

-- Both were part of `suppliers.manage`, which the stock clerk holds. Money moves to owners and
-- managers; custom roles a tenant deliberately gave supplier management keep both keys.
INSERT INTO "role_permission" ("id", "tenant_id", "role_id", "permission_key")
SELECT gen_random_uuid(), r."tenant_id", r."id", k."key"
FROM "role" r
CROSS JOIN (VALUES ('purchasing.invoice'), ('suppliers.pay')) AS k("key")
WHERE (r."is_system" = true AND r."key" IN ('owner', 'manager'))
   OR (r."is_system" = false AND EXISTS (
     SELECT 1 FROM "role_permission" rp
     WHERE rp."role_id" = r."id" AND rp."permission_key" = 'suppliers.manage'
   ))
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
