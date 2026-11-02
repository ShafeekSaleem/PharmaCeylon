-- P2 go-live evidence (D-W1): a confirmed test receipt printed at an enrolled counter.
CREATE TABLE "terminal_test_receipt" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "terminal_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "key_id" VARCHAR(128) NOT NULL,
    "work_session_id" UUID NOT NULL,
    "confirmed_by" UUID NOT NULL,
    "printer_name" VARCHAR(260) NOT NULL,
    "confirmed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "terminal_test_receipt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "terminal_test_receipt_tenant_id_branch_id_confirmed_at_idx" ON "terminal_test_receipt"("tenant_id", "branch_id", "confirmed_at");

ALTER TABLE "terminal_test_receipt" ADD CONSTRAINT "terminal_test_receipt_tenant_id_branch_id_terminal_id_enr_fkey" FOREIGN KEY ("tenant_id", "branch_id", "terminal_id", "enrollment_id", "key_id") REFERENCES "terminal_enrollment"("tenant_id", "branch_id", "terminal_id", "id", "key_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE terminal_test_receipt ADD CONSTRAINT terminal_test_receipt_printer_check CHECK (length(trim(printer_name)) > 0);

CREATE POLICY pc_tenant_isolation ON terminal_test_receipt
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- RLS remains disabled, consistent with the staged inventory.
