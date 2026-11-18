-- P4 #50, receipt numbering option A: each till's offline receipts are numbered under its own
-- prefix (C1R, C2R, ...), given on its first offline grant and never reused at the branch.
ALTER TABLE "terminal_counter" ADD COLUMN "offline_receipt_prefix" VARCHAR(8);

ALTER TABLE "terminal_counter" ADD CONSTRAINT "terminal_counter_offline_receipt_prefix_shape"
  CHECK ("offline_receipt_prefix" IS NULL OR "offline_receipt_prefix" ~ '^C[1-9][0-9]{0,3}R$');

-- Postgres treats NULLs as distinct, so tills without a prefix yet don't collide.
CREATE UNIQUE INDEX "terminal_counter_offline_receipt_prefix_key"
  ON "terminal_counter" ("tenant_id", "branch_id", "offline_receipt_prefix");
