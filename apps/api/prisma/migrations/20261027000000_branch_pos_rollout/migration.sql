-- W1 (D-W1, D-W7): one per-branch desktop POS rollout switch. Additive only: every existing
-- branch starts not live, so its web pages behave exactly as before.
CREATE TYPE "DesktopPosRollout" AS ENUM ('not_live', 'live');

ALTER TABLE "branch"
  ADD COLUMN "desktop_pos_rollout" "DesktopPosRollout" NOT NULL DEFAULT 'not_live',
  ADD COLUMN "desktop_pos_live_at" TIMESTAMP(3),
  ADD COLUMN "pos_fallback_started_at" TIMESTAMP(3),
  ADD COLUMN "pos_fallback_ends_at" TIMESTAMP(3);

-- A live branch records when it went live; a fallback belongs to a live branch, has both ends,
-- and ends after it starts.
ALTER TABLE "branch" ADD CONSTRAINT "branch_pos_rollout_shape" CHECK (
  ("desktop_pos_rollout" = 'live') = ("desktop_pos_live_at" IS NOT NULL)
  AND ("pos_fallback_started_at" IS NULL) = ("pos_fallback_ends_at" IS NULL)
  AND ("pos_fallback_ends_at" IS NULL
    OR ("desktop_pos_rollout" = 'live' AND "pos_fallback_ends_at" > "pos_fallback_started_at"))
);
