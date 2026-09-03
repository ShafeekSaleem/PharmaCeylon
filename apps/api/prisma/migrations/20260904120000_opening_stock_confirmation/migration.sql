-- Posting opening stock is a fact; agreeing that it matches the shelves is a decision. The
-- readiness journey was treating the first as the second, so an import of a few thousand units
-- ticked the step off before anyone had counted anything.
ALTER TABLE "branch" ADD COLUMN "opening_stock_confirmed_at" TIMESTAMP(3);

-- Branches already selling are not asked to go back and confirm history they can't change.
UPDATE "branch" SET "opening_stock_confirmed_at" = "setup_completed_at"
WHERE "setup_completed_at" IS NOT NULL;
