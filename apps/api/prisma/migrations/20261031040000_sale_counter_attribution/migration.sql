-- P2: which enrolled counter, till and staff session a sale was rung up on. Taken from the
-- seller's own verified open session; web POS sales leave these null.
ALTER TABLE "sale" ADD COLUMN "terminal_id" UUID;
ALTER TABLE "sale" ADD COLUMN "till_id" UUID;
ALTER TABLE "sale" ADD COLUMN "work_session_id" UUID;
ALTER TABLE sale ADD CONSTRAINT sale_counter_attribution_check CHECK (
  (terminal_id IS NULL) = (till_id IS NULL) AND (terminal_id IS NULL) = (work_session_id IS NULL)
);
CREATE INDEX "sale_tenant_id_till_id_sold_at_idx" ON "sale"("tenant_id", "till_id", "sold_at" DESC) WHERE till_id IS NOT NULL;
