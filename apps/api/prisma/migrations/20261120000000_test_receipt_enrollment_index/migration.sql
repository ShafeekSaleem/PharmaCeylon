-- P2b #103: every enrollment status reads that enrollment's latest confirmed test receipt.
CREATE INDEX "terminal_test_receipt_enrollment_confirmed_idx" ON "terminal_test_receipt"("tenant_id", "branch_id", "enrollment_id", "confirmed_at");
