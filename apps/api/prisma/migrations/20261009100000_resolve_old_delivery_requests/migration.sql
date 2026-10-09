-- "Ask an approver" used to send a notice per request that nothing ever resolved, so once the
-- delivery was dealt with it sat at the top of the approver's list for good. Held deliveries now
-- carry their own notices and resolve them when decided; the old ones are done with.
UPDATE "notification"
SET "resolved_at" = NOW()
WHERE "resolved_at" IS NULL
  AND "entity_type" = 'purchase_order'
  AND (
    "title" LIKE '%: a delivery is waiting for your approval'
    OR "title" LIKE '% is waiting for your approval'
  );
