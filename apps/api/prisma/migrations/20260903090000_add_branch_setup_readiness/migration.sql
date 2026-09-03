ALTER TABLE "branch"
  ADD COLUMN "setup_required" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "setup_mode" TEXT NOT NULL DEFAULT 'fresh',
  ADD COLUMN "sales_settings_reviewed_at" TIMESTAMP(3),
  ADD COLUMN "checkout_prepared_at" TIMESTAMP(3),
  ADD COLUMN "setup_completed_at" TIMESTAMP(3);

ALTER TABLE "branch"
  ADD CONSTRAINT "branch_setup_mode_check"
  CHECK ("setup_mode" IN ('fresh', 'migrating'));
