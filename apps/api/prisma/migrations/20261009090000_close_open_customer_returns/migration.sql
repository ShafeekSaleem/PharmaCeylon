-- Customer returns are refunds at the till now, finished the moment they are raised. Any still
-- open from the old Returns page (draft, waiting for approval, awaiting pickup, in review) never
-- refunded anyone and can't be completed any more, so they are closed as cancelled. Nothing
-- about stock or money changes: an open return had moved neither.
UPDATE "goods_return"
SET "status" = 'cancelled',
    "notes" = TRIM(BOTH E'\n' FROM COALESCE("notes", '') || E'\n' || 'Closed when customer returns moved to POS refunds.'),
    "updated_at" = NOW()
WHERE "type" = 'customer'
  AND "status" IN ('draft', 'pending_approval', 'awaiting_logistics', 'in_review');
