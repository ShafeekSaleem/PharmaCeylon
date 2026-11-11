-- P5 #51 review: a counter's own clock may run backwards between a backup and its restore (a reset
-- CMOS clock on a computer back from repair, or a fast clock corrected since the backup). The
-- report is still recorded, and the back office is shown the disagreement, so the shape no longer
-- requires "backup_taken_at" <= "restored_at". Everything else is unchanged.
--
-- Strictly looser than the constraint it replaces, so every existing row satisfies it; the table
-- holds one row per restore.
ALTER TABLE "offline_counter_restore"
  DROP CONSTRAINT "offline_counter_restore_shape",
  ADD CONSTRAINT "offline_counter_restore_shape" CHECK (
    jsonb_typeof("envelope") = 'object'
    AND length("backup_id") > 0
    AND "journal_head_sequence" >= 0 AND "accepted_sequence" >= 0 AND "server_head_sequence" >= 0
    AND "accepted_sequence" <= "journal_head_sequence"
    AND (("journal_head_sequence" = 0) = ("journal_head_hash" IS NULL))
    AND (("accepted_sequence" = 0) = ("accepted_hash" IS NULL))
    AND (("server_head_sequence" = 0) = ("server_head_hash" IS NULL))
    AND ("journal_head_hash" IS NULL OR "journal_head_hash" ~ '^[0-9a-f]{64}$')
    AND ("accepted_hash" IS NULL OR "accepted_hash" ~ '^[0-9a-f]{64}$')
    AND ("server_head_hash" IS NULL OR "server_head_hash" ~ '^[0-9a-f]{64}$')
    AND ("removed_grant_version" IS NULL OR "removed_grant_version" >= 1)
    AND "latest_grant_version" >= 0
    -- An acknowledgement is whole or absent, by an owner or a delegated manager, with a reason.
    AND (("status" = 'acknowledged') = ("acknowledged_at" IS NOT NULL))
    AND (("acknowledged_at" IS NULL) = ("acknowledged_by_user_id" IS NULL))
    AND (("acknowledged_at" IS NULL) = ("acknowledgement_reason" IS NULL))
    AND (("acknowledged_at" IS NULL) = ("acknowledgement_authority" IS NULL))
    AND ("acknowledgement_reason" IS NULL OR length(btrim("acknowledgement_reason")) > 0)
    AND ("acknowledgement_authority" IS NULL OR "acknowledgement_authority" IN ('owner', 'delegated_manager'))
    AND (("acknowledgement_authority" = 'delegated_manager') = ("acknowledgement_delegation_id" IS NOT NULL))
    AND ("acknowledged_at" IS NULL OR "acknowledged_at" >= "created_at")
  );
