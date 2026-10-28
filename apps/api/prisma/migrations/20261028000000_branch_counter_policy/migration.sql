ALTER TABLE "branch"
  ADD COLUMN "counter_policy" JSONB,
  ADD COLUMN "counter_policy_version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "branch" ADD CONSTRAINT "branch_counter_policy_version_positive"
  CHECK ("counter_policy_version" > 0);
