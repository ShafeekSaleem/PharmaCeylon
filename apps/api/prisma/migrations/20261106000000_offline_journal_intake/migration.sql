-- P5 #51: server-side intake of the nominated counter's offline journal. Signed staff sign-ins
-- are kept as evidence; accepted commands are `terminal_command_receipt` rows with their
-- `offline_sequence`; uploads that are held, rejected or conflict are retained for review.
-- Offline sales post their stock with the sale, or (approved D1) keep the sale and payment and
-- open a discrepancy case that blocks the sale's batches until it is accounted for. Offline
-- shift_open / shift_close replay into `till_shift`. Additive: every existing sale is `posted`.

CREATE TYPE "SaleStockPosting" AS ENUM ('posted', 'pending_reconciliation');
CREATE TYPE "OfflineStockDiscrepancyStatus" AS ENUM ('open', 'resolved');

-- Metadata-only on PostgreSQL 11+: a constant default does not rewrite `sale`.
ALTER TABLE "sale" ADD COLUMN "offline_command_id" UUID,
  ADD COLUMN "stock_posting" "SaleStockPosting" NOT NULL DEFAULT 'posted';
-- Only a sale replayed from the offline journal can be waiting on a reconciliation case.
-- NOT VALID here and validated by the next migration, so deploying holds no long lock on `sale`.
ALTER TABLE "sale" ADD CONSTRAINT "sale_stock_posting_offline_check" CHECK (
  "stock_posting" = 'posted' OR "offline_command_id" IS NOT NULL
) NOT VALID;

ALTER TABLE "till_shift" ADD COLUMN "open_command_id" UUID,
  ADD COLUMN "opened_sign_in_id" UUID,
  ADD COLUMN "closed_sign_in_id" UUID,
  ALTER COLUMN "opened_staff_session_id" DROP NOT NULL;
CREATE UNIQUE INDEX "till_shift_open_command_id_key" ON "till_shift"("open_command_id");

-- The shape from #125, widened for D7b offline replay: a shift is opened either from an online
-- staff session or from a signed shift_open command and its offline sign-in, and closed from an
-- online staff session or an offline sign-in. Everything else is unchanged.
ALTER TABLE "till_shift" DROP CONSTRAINT "till_shift_shape";
ALTER TABLE "till_shift" ADD CONSTRAINT "till_shift_shape" CHECK (
  "currency" = 'LKR' AND "opening_cash_minor" >= 0
  AND jsonb_typeof("opening_count") = 'array'
  AND ("opened_staff_session_id" IS NOT NULL
    OR ("open_command_id" IS NOT NULL AND "opened_sign_in_id" IS NOT NULL))
  AND (("open_command_id" IS NULL) = ("opened_sign_in_id" IS NULL))
  AND (
    ("closed_at" IS NULL AND "closing_cash_count_minor" IS NULL AND "closing_count" IS NULL
      AND "expected_cash_minor" IS NULL AND "counter_expected_cash_minor" IS NULL
      AND "variance_minor" IS NULL AND "closed_by_user_id" IS NULL AND "closed_staff_session_id" IS NULL
      AND "closed_sign_in_id" IS NULL
      AND "close_kind" IS NULL AND "assistance_reason" IS NULL AND "variance_note" IS NULL
      AND "close_command_id" IS NULL)
    OR
    ("closed_at" IS NOT NULL AND "closed_at" >= "opened_at"
      AND "closing_cash_count_minor" >= 0 AND jsonb_typeof("closing_count") = 'array'
      AND "expected_cash_minor" IS NOT NULL
      AND "variance_minor" = "closing_cash_count_minor" - "expected_cash_minor"
      AND "closed_by_user_id" IS NOT NULL
      AND ("closed_staff_session_id" IS NOT NULL OR "closed_sign_in_id" IS NOT NULL)
      AND "close_command_id" IS NOT NULL
      AND (("close_kind" = 'self' AND "closed_by_user_id" = "staff_user_id" AND "assistance_reason" IS NULL)
        OR ("close_kind" = 'assisted' AND "closed_by_user_id" <> "staff_user_id"
          AND length(btrim("assistance_reason")) > 0)))
  )
) NOT VALID;

-- Closing may now also set the offline sign-in it came from; nothing else changes.
CREATE OR REPLACE FUNCTION pc_preserve_till_shift() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE closing text[] := ARRAY['closed_at', 'closing_cash_count_minor', 'closing_count',
  'expected_cash_minor', 'counter_expected_cash_minor', 'variance_minor', 'closed_by_user_id',
  'closed_staff_session_id', 'closed_sign_in_id', 'close_kind', 'assistance_reason', 'variance_note',
  'close_command_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Till shifts must be retained'; END IF;
  IF OLD.closed_at IS NOT NULL THEN RAISE EXCEPTION 'A closed till shift is immutable'; END IF;
  IF (to_jsonb(NEW) - closing) IS DISTINCT FROM (to_jsonb(OLD) - closing) THEN
    RAISE EXCEPTION 'Only closing a till shift may change it';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE "offline_staff_sign_in" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "terminal_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "key_id" VARCHAR(128) NOT NULL,
    "sign_in_id" UUID NOT NULL,
    "sign_in_hash" CHAR(64) NOT NULL,
    "staff_user_id" UUID NOT NULL,
    "work_session_id" UUID NOT NULL,
    "grant_id" UUID NOT NULL,
    "authenticated_at" TIMESTAMP(3) NOT NULL,
    "envelope" JSONB NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_by_user_id" UUID NOT NULL,

    CONSTRAINT "offline_staff_sign_in_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "offline_staff_sign_in_shape" CHECK ("sign_in_hash" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "offline_journal_review" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "terminal_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "key_id" VARCHAR(128) NOT NULL,
    "record_kind" VARCHAR(16) NOT NULL,
    "record_id" UUID NOT NULL,
    "sequence" BIGINT,
    "record_hash" CHAR(64) NOT NULL,
    "outcome" VARCHAR(16) NOT NULL,
    "error_code" VARCHAR(64) NOT NULL,
    "original_record_hash" CHAR(64),
    "envelope" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "first_received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_by_user_id" UUID NOT NULL,

    CONSTRAINT "offline_journal_review_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "offline_journal_review_shape" CHECK (
      "record_kind" IN ('command', 'staff_sign_in')
      AND "outcome" IN ('held', 'rejected', 'conflict')
      AND "record_hash" ~ '^[0-9a-f]{64}$'
      AND ("sequence" IS NULL OR "sequence" >= 1)
      AND (("record_kind" = 'command') = ("sequence" IS NOT NULL))
      AND "attempts" >= 1 AND "last_received_at" >= "first_received_at"
    )
);

CREATE TABLE "offline_stock_discrepancy" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "terminal_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "key_id" VARCHAR(128) NOT NULL,
    "command_id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "snapshot_version" INTEGER NOT NULL,
    "status" "OfflineStockDiscrepancyStatus" NOT NULL DEFAULT 'open',
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "offline_stock_discrepancy_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "offline_stock_discrepancy_shape" CHECK (
      "snapshot_version" >= 1
      AND (("status" = 'open') = ("resolved_at" IS NULL))
    )
);

CREATE TABLE "offline_stock_discrepancy_line" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "sold_quantity" INTEGER NOT NULL,
    "available_quantity_at_sync" INTEGER NOT NULL,
    "shortfall_quantity" INTEGER NOT NULL,
    "reason" VARCHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offline_stock_discrepancy_line_pkey" PRIMARY KEY ("id"),
    -- The shortfall is exactly what central stock could not cover; never clamped away.
    CONSTRAINT "offline_stock_discrepancy_line_shape" CHECK (
      "sold_quantity" > 0 AND "available_quantity_at_sync" >= 0
      AND "shortfall_quantity" = GREATEST("sold_quantity" - "available_quantity_at_sync", 0)
      AND "reason" IN ('shortfall', 'batch_under_review', 'sale_pending')
      AND (("reason" = 'shortfall') = ("shortfall_quantity" > 0))
    )
);

CREATE TABLE "batch_sale_block" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMP(3),

    CONSTRAINT "batch_sale_block_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "batch_sale_block_shape" CHECK ("released_at" IS NULL OR "released_at" >= "created_at")
);

CREATE UNIQUE INDEX "offline_staff_sign_in_tenant_id_enrollment_id_sign_in_id_key" ON "offline_staff_sign_in"("tenant_id", "enrollment_id", "sign_in_id");
CREATE INDEX "offline_journal_review_tenant_id_branch_id_outcome_idx" ON "offline_journal_review"("tenant_id", "branch_id", "outcome");
CREATE UNIQUE INDEX "offline_journal_review_content_key" ON "offline_journal_review"("tenant_id", "enrollment_id", "record_kind", "record_hash");
CREATE UNIQUE INDEX "offline_stock_discrepancy_sale_id_key" ON "offline_stock_discrepancy"("sale_id");
CREATE INDEX "offline_stock_discrepancy_tenant_id_branch_id_status_idx" ON "offline_stock_discrepancy"("tenant_id", "branch_id", "status");
CREATE UNIQUE INDEX "offline_stock_discrepancy_tenant_id_enrollment_id_command_i_key" ON "offline_stock_discrepancy"("tenant_id", "enrollment_id", "command_id");
CREATE UNIQUE INDEX "offline_stock_discrepancy_tenant_id_branch_id_id_key" ON "offline_stock_discrepancy"("tenant_id", "branch_id", "id");
CREATE UNIQUE INDEX "offline_stock_discrepancy_line_case_id_batch_id_key" ON "offline_stock_discrepancy_line"("case_id", "batch_id");
CREATE INDEX "batch_sale_block_tenant_id_batch_id_idx" ON "batch_sale_block"("tenant_id", "batch_id");
CREATE UNIQUE INDEX "batch_sale_block_case_id_batch_id_key" ON "batch_sale_block"("case_id", "batch_id");
-- Checkout and snapshot issuance ask "is this batch blocked now?".
CREATE INDEX "batch_sale_block_open_idx" ON "batch_sale_block"("tenant_id", "branch_id", "batch_id")
  WHERE "released_at" IS NULL;

ALTER TABLE "offline_staff_sign_in" ADD CONSTRAINT "offline_staff_sign_in_enrollment_fkey" FOREIGN KEY ("tenant_id", "branch_id", "terminal_id", "enrollment_id", "key_id") REFERENCES "terminal_enrollment"("tenant_id", "branch_id", "terminal_id", "id", "key_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "offline_journal_review" ADD CONSTRAINT "offline_journal_review_enrollment_fkey" FOREIGN KEY ("tenant_id", "branch_id", "terminal_id", "enrollment_id", "key_id") REFERENCES "terminal_enrollment"("tenant_id", "branch_id", "terminal_id", "id", "key_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "offline_stock_discrepancy" ADD CONSTRAINT "offline_stock_discrepancy_enrollment_fkey" FOREIGN KEY ("tenant_id", "branch_id", "terminal_id", "enrollment_id", "key_id") REFERENCES "terminal_enrollment"("tenant_id", "branch_id", "terminal_id", "id", "key_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "offline_stock_discrepancy" ADD CONSTRAINT "offline_stock_discrepancy_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sale"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "offline_stock_discrepancy_line" ADD CONSTRAINT "offline_stock_discrepancy_line_tenant_id_branch_id_case_id_fkey" FOREIGN KEY ("tenant_id", "branch_id", "case_id") REFERENCES "offline_stock_discrepancy"("tenant_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "offline_stock_discrepancy_line" ADD CONSTRAINT "offline_stock_discrepancy_line_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "batch_sale_block" ADD CONSTRAINT "batch_sale_block_tenant_id_branch_id_case_id_fkey" FOREIGN KEY ("tenant_id", "branch_id", "case_id") REFERENCES "offline_stock_discrepancy"("tenant_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "batch_sale_block" ADD CONSTRAINT "batch_sale_block_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Offline journal evidence is retained: sign-ins and case lines never change, and nothing here
-- is deleted. A retained upload only counts repeats; a case and its blocks change only by being
-- accounted for, once (resolution is a later P5 slice).
CREATE FUNCTION pc_immutable_offline_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '% rows must be retained', TG_TABLE_NAME; END IF;
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER retain_offline_staff_sign_in BEFORE UPDATE OR DELETE ON offline_staff_sign_in
  FOR EACH ROW EXECUTE FUNCTION pc_immutable_offline_evidence();
CREATE TRIGGER retain_offline_stock_discrepancy_line BEFORE UPDATE OR DELETE ON offline_stock_discrepancy_line
  FOR EACH ROW EXECUTE FUNCTION pc_immutable_offline_evidence();

CREATE FUNCTION pc_retain_offline_journal_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE counters text[] := ARRAY['attempts', 'last_received_at', 'error_code'];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'offline_journal_review rows must be retained'; END IF;
  IF (to_jsonb(NEW) - counters) IS DISTINCT FROM (to_jsonb(OLD) - counters) THEN
    RAISE EXCEPTION 'A retained journal upload keeps its content';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER retain_offline_journal_review BEFORE UPDATE OR DELETE ON offline_journal_review
  FOR EACH ROW EXECUTE FUNCTION pc_retain_offline_journal_review();

CREATE FUNCTION pc_retain_offline_stock_discrepancy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resolution text[] := ARRAY['status', 'resolved_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'offline_stock_discrepancy rows must be retained'; END IF;
  IF OLD.status = 'resolved' OR (to_jsonb(NEW) - resolution) IS DISTINCT FROM (to_jsonb(OLD) - resolution) THEN
    RAISE EXCEPTION 'A discrepancy case changes only by being resolved, once';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER retain_offline_stock_discrepancy BEFORE UPDATE OR DELETE ON offline_stock_discrepancy
  FOR EACH ROW EXECUTE FUNCTION pc_retain_offline_stock_discrepancy();

CREATE FUNCTION pc_retain_batch_sale_block() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'batch_sale_block rows must be retained'; END IF;
  IF OLD.released_at IS NOT NULL OR (to_jsonb(NEW) - 'released_at') IS DISTINCT FROM (to_jsonb(OLD) - 'released_at') THEN
    RAISE EXCEPTION 'A batch sale block changes only by being released, once';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER retain_batch_sale_block BEFORE UPDATE OR DELETE ON batch_sale_block
  FOR EACH ROW EXECUTE FUNCTION pc_retain_batch_sale_block();

CREATE POLICY pc_tenant_isolation ON offline_staff_sign_in
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pc_tenant_isolation ON offline_journal_review
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pc_tenant_isolation ON offline_stock_discrepancy
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pc_tenant_isolation ON offline_stock_discrepancy_line
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pc_tenant_isolation ON batch_sale_block
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- RLS remains disabled, consistent with the staged inventory.
