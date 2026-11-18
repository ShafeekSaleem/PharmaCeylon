-- P4 #50 (review of #208): a card attempt can end `not_used` — approved on the card machine, but no
-- sale used it, so the money was reversed there (with that slip's reference) or is owed back. The
-- settlement, its reference and the reason live in the signed envelope; the columns keep what every
-- card state shares: the approval's own reference and who said so. Held as `card_not_used` for a
-- manager; promotion never accepts it on its own.
ALTER TABLE offline_support_record DROP CONSTRAINT offline_support_record_shape;
ALTER TABLE offline_support_record ADD CONSTRAINT offline_support_record_shape CHECK (
  record_hash ~ '^[0-9a-f]{64}$'
  AND status IN ('held', 'accepted', 'rejected')
  AND (status <> 'held' OR verified_at IS NULL)
  AND (status = 'held' OR verified_at IS NOT NULL)
  AND (
    (kind = 'sale_incident'
      AND sale_command_id IS NOT NULL AND recorded_by_user_id IS NOT NULL
      AND incident_category IN ('quantity_error', 'payment_uncertain', 'customer_dispute', 'other')
      AND length(trim(description)) > 0
      AND attempt_id IS NULL AND checkout_draft_id IS NULL AND reviewed_sale_digest IS NULL
      AND amount_minor IS NULL AND card_state IS NULL AND provider_reference IS NULL
      AND approval_code IS NULL AND approved_at IS NULL AND verified_by_user_id IS NULL)
    OR (kind = 'external_card_attempt'
      AND attempt_id IS NOT NULL AND checkout_draft_id IS NOT NULL
      AND reviewed_sale_digest ~ '^[0-9a-f]{64}$' AND amount_minor > 0
      AND recorded_by_user_id IS NULL AND incident_category IS NULL AND description IS NULL
      AND (
        (card_state IN ('prepared', 'uncertain')
          AND provider_reference IS NULL AND approval_code IS NULL AND approved_at IS NULL
          AND verified_by_user_id IS NULL AND sale_command_id IS NULL)
        OR (card_state = 'approved'
          AND provider_reference IS NOT NULL AND approval_code IS NOT NULL AND approved_at IS NOT NULL
          AND verified_by_user_id IS NULL AND sale_command_id IS NULL)
        OR (card_state = 'declined'
          AND provider_reference IS NOT NULL AND verified_by_user_id IS NOT NULL
          AND approval_code IS NULL AND approved_at IS NULL AND sale_command_id IS NULL)
        OR (card_state = 'not_used'
          AND provider_reference IS NOT NULL AND verified_by_user_id IS NOT NULL
          AND approval_code IS NULL AND approved_at IS NULL AND sale_command_id IS NULL)
        OR (card_state = 'linked_to_sale'
          AND provider_reference IS NOT NULL AND sale_command_id IS NOT NULL
          AND approval_code IS NULL AND approved_at IS NULL AND verified_by_user_id IS NULL)
      ))
  )
);
