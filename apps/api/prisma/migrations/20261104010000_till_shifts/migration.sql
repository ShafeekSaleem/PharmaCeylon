-- P2b #103: online till shifts and cash. One shift per person per till, opened and closed with a
-- counted drawer; the record matches D7b's shift_open / shift_close so P4 can write it offline and
-- P5 replay it. Additive: existing sales, payments and returns keep shift_id NULL.

CREATE TYPE "TillShiftCloseKind" AS ENUM ('self', 'assisted');
CREATE TYPE "TillCashMovementDirection" AS ENUM ('in', 'out');

CREATE TABLE "till_shift" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "register_id" UUID NOT NULL,
    "till_id" UUID NOT NULL,
    "terminal_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "staff_user_id" UUID NOT NULL,
    "opened_staff_session_id" UUID NOT NULL,
    "previous_closed_work_session_id" UUID,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'LKR',
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opening_cash_minor" INTEGER NOT NULL,
    "opening_count" JSONB NOT NULL,
    "closed_at" TIMESTAMP(3),
    "closing_cash_count_minor" INTEGER,
    "closing_count" JSONB,
    "expected_cash_minor" INTEGER,
    "counter_expected_cash_minor" INTEGER,
    "variance_minor" INTEGER,
    "closed_by_user_id" UUID,
    "closed_staff_session_id" UUID,
    "close_kind" "TillShiftCloseKind",
    "assistance_reason" VARCHAR(500),
    "close_command_id" UUID,

    CONSTRAINT "till_shift_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "till_cash_movement" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "direction" "TillCashMovementDirection" NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "reason" VARCHAR(300) NOT NULL,
    "reference_type" VARCHAR(40),
    "reference_id" UUID,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "till_cash_movement_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "sale" ADD COLUMN "shift_id" UUID;
ALTER TABLE "sale_payment" ADD COLUMN "shift_id" UUID;
ALTER TABLE "goods_return" ADD COLUMN "shift_id" UUID;

CREATE UNIQUE INDEX "till_shift_close_command_id_key" ON "till_shift"("close_command_id");
CREATE INDEX "till_shift_tenant_id_till_id_opened_at_idx" ON "till_shift"("tenant_id", "till_id", "opened_at" DESC);
CREATE UNIQUE INDEX "till_shift_tenant_id_id_key" ON "till_shift"("tenant_id", "id");
CREATE UNIQUE INDEX "till_shift_tenant_id_branch_id_id_key" ON "till_shift"("tenant_id", "branch_id", "id");
CREATE INDEX "till_cash_movement_tenant_id_shift_id_idx" ON "till_cash_movement"("tenant_id", "shift_id");
CREATE INDEX "sale_tenant_id_shift_id_idx" ON "sale"("tenant_id", "shift_id");
CREATE INDEX "sale_payment_tenant_id_shift_id_idx" ON "sale_payment"("tenant_id", "shift_id");

-- Only one shift is open on a till at a time. Concurrent opens race on this index; the loser is
-- refused, not queued.
CREATE UNIQUE INDEX "till_shift_one_open_per_till" ON "till_shift" ("tenant_id", "till_id")
  WHERE "closed_at" IS NULL;

ALTER TABLE "till_shift" ADD CONSTRAINT "till_shift_tenant_id_branch_id_register_id_till_id_fkey" FOREIGN KEY ("tenant_id", "branch_id", "register_id", "till_id") REFERENCES "terminal_counter"("tenant_id", "branch_id", "id", "till_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "till_cash_movement" ADD CONSTRAINT "till_cash_movement_tenant_id_branch_id_shift_id_fkey" FOREIGN KEY ("tenant_id", "branch_id", "shift_id") REFERENCES "till_shift"("tenant_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "sale" ADD CONSTRAINT "sale_tenant_id_branch_id_shift_id_fkey" FOREIGN KEY ("tenant_id", "branch_id", "shift_id") REFERENCES "till_shift"("tenant_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "sale_payment" ADD CONSTRAINT "sale_payment_tenant_id_shift_id_fkey" FOREIGN KEY ("tenant_id", "shift_id") REFERENCES "till_shift"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "goods_return" ADD CONSTRAINT "goods_return_tenant_id_branch_id_shift_id_fkey" FOREIGN KEY ("tenant_id", "branch_id", "shift_id") REFERENCES "till_shift"("tenant_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- An open shift has no close fields; a closed one has all of them, its variance is the count
-- less the expected cash, and an assisted close names someone other than the shift's owner and
-- says why. Counts are never negative.
ALTER TABLE "till_shift" ADD CONSTRAINT "till_shift_shape" CHECK (
  "currency" = 'LKR' AND "opening_cash_minor" >= 0
  AND jsonb_typeof("opening_count") = 'array'
  AND (
    ("closed_at" IS NULL AND "closing_cash_count_minor" IS NULL AND "closing_count" IS NULL
      AND "expected_cash_minor" IS NULL AND "counter_expected_cash_minor" IS NULL
      AND "variance_minor" IS NULL AND "closed_by_user_id" IS NULL AND "closed_staff_session_id" IS NULL
      AND "close_kind" IS NULL AND "assistance_reason" IS NULL AND "close_command_id" IS NULL)
    OR
    ("closed_at" IS NOT NULL AND "closed_at" >= "opened_at"
      AND "closing_cash_count_minor" >= 0 AND jsonb_typeof("closing_count") = 'array'
      AND "expected_cash_minor" IS NOT NULL
      AND "variance_minor" = "closing_cash_count_minor" - "expected_cash_minor"
      AND "closed_by_user_id" IS NOT NULL AND "closed_staff_session_id" IS NOT NULL
      AND "close_command_id" IS NOT NULL
      AND (("close_kind" = 'self' AND "closed_by_user_id" = "staff_user_id" AND "assistance_reason" IS NULL)
        OR ("close_kind" = 'assisted' AND "closed_by_user_id" <> "staff_user_id"
          AND length(btrim("assistance_reason")) > 0)))
  )
);

ALTER TABLE "till_cash_movement" ADD CONSTRAINT "till_cash_movement_shape" CHECK (
  "amount_minor" > 0 AND length(btrim("reason")) > 0
);

-- A shift is retained and closes once. After that nothing on it changes, so a shortage or
-- overage stays on record whatever the next shift's opening count says.
CREATE FUNCTION pc_preserve_till_shift() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE closing text[] := ARRAY['closed_at', 'closing_cash_count_minor', 'closing_count',
  'expected_cash_minor', 'counter_expected_cash_minor', 'variance_minor', 'closed_by_user_id',
  'closed_staff_session_id', 'close_kind', 'assistance_reason', 'close_command_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Till shifts must be retained'; END IF;
  IF OLD.closed_at IS NOT NULL THEN RAISE EXCEPTION 'A closed till shift is immutable'; END IF;
  IF (to_jsonb(NEW) - closing) IS DISTINCT FROM (to_jsonb(OLD) - closing) THEN
    RAISE EXCEPTION 'Only closing a till shift may change it';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_till_shift BEFORE UPDATE OR DELETE ON till_shift
  FOR EACH ROW EXECUTE FUNCTION pc_preserve_till_shift();

-- Cash movements are a ledger: appended, never edited or removed.
CREATE FUNCTION pc_preserve_till_cash_movement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Till cash movements are append-only';
END;
$$;
CREATE TRIGGER preserve_till_cash_movement BEFORE UPDATE OR DELETE ON till_cash_movement
  FOR EACH ROW EXECUTE FUNCTION pc_preserve_till_cash_movement();

-- Closing another person's shift at the counter (the absent-cashier close). Owners and managers
-- by default, matching the catalog; custom roles opt in.
INSERT INTO "permission" ("key", "module", "label", "description") VALUES
  ('shifts.close_others', 'shifts', 'Close another person''s shift at the counter',
   'Close the open shift of someone who is not at the counter, with your own PIN, a reason and the counted drawer. They stay on the record as the shift''s owner.')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permission" ("id", "tenant_id", "role_id", "permission_key")
SELECT gen_random_uuid(), r."tenant_id", r."id", 'shifts.close_others'
FROM "role" r
WHERE r."is_system" = true AND r."key" IN ('owner', 'manager')
ON CONFLICT ("role_id", "permission_key") DO NOTHING;

CREATE POLICY pc_tenant_isolation ON till_shift
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pc_tenant_isolation ON till_cash_movement
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- RLS remains disabled, consistent with the staged inventory.
