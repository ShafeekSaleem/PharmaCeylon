-- Two corrections to the supplier money model, as their own migration because the first one
-- is already applied in places and an applied migration is never edited.

-- ── Supplier payments get their own methods ────────────────────────────────────────────────
-- They were typed with the POS tenders, but nobody pays a wholesaler by mobile wallet at a
-- till, and the two common ways — bank transfer and cheque — never happen at one.
CREATE TYPE "SupplierPaymentMethod" AS ENUM ('bank_transfer', 'cheque', 'cash', 'card', 'other');

ALTER TABLE "supplier_payment" ALTER COLUMN "method" DROP DEFAULT;
ALTER TABLE "supplier_payment"
  ALTER COLUMN "method" TYPE "SupplierPaymentMethod"
  USING (
    CASE
      -- Payments reconstructed from the old paid-amount field: nobody recorded how they were
      -- made, so they are not claimed as cash.
      WHEN "payment_no" LIKE 'PAY-LEGACY-%' THEN 'other'
      WHEN "method"::text = 'cash' THEN 'cash'
      WHEN "method"::text = 'card' THEN 'card'
      ELSE 'other'
    END
  )::"SupplierPaymentMethod";
ALTER TABLE "supplier_payment" ALTER COLUMN "method" SET DEFAULT 'bank_transfer';

-- ── Invoice numbers are unique per supplier ────────────────────────────────────────────────
-- They are the supplier's numbers, and two suppliers can both print "INV-1001". The old
-- tenant-wide constraint was stricter than this one, so narrowing it cannot create a clash in
-- existing data.
DROP INDEX IF EXISTS "supplier_invoice_tenant_id_invoice_number_key";
CREATE UNIQUE INDEX "supplier_invoice_tenant_id_supplier_id_invoice_number_key"
  ON "supplier_invoice" ("tenant_id", "supplier_id", "invoice_number");

-- ── Only a delivery makes a placeholder ────────────────────────────────────────────────────
-- The first migration marked every existing invoice `system`, but an invoice with no delivery
-- behind it was typed in by a person from the supplier's document (the supplier page's "Add
-- invoice"). It is the supplier's invoice, not one waiting to be replaced, and showing it under
-- "awaiting invoice" would ask someone to record it a second time.
UPDATE "supplier_invoice"
SET "source" = 'supplier'
WHERE "source" = 'system' AND "goods_receipt_id" IS NULL;
