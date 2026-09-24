-- Price variance: what was agreed, what was billed, and who accepted the difference.
--
-- A delivery could already be booked at a price above the one the order agreed, and nobody was
-- told. The quantities were policed; the money was not.

ALTER TABLE "tenant_settings"
  ADD COLUMN "purchase_price_variance_tolerance_percent" DECIMAL(5, 2) NOT NULL DEFAULT 0;

-- Both sides of the price live on the delivery line, so the variance is answerable without
-- reading the order back — and stays answerable if the order is archived.
ALTER TABLE "goods_receipt_item"
  ADD COLUMN "ordered_unit_cost" DECIMAL(12, 2);

ALTER TABLE "goods_receipt"
  ADD COLUMN "supplier_delivery_note" VARCHAR(64);

-- Historic deliveries: the order's agreed cost is the best record of what was expected, and it
-- is the number the old receiving form prefilled, so it is what those deliveries were booked at.
UPDATE "goods_receipt_item" gri
SET "ordered_unit_cost" = poi."unit_cost"
FROM "goods_receipt" gr
JOIN "purchase_order_item" poi ON poi."purchase_order_id" = gr."purchase_order_id"
WHERE gr."id" = gri."goods_receipt_id"
  AND poi."product_id" = gri."product_id"
  AND gri."ordered_unit_cost" IS NULL;
