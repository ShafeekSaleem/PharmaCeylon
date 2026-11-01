-- P1 #47: idempotent persistence for device-signed support records (sale-incident notes and
-- external-card attempt events), plus retained conflicting uploads. Additive. The exact signed
-- envelope and its SHA-256 are retained; one record per tenant + enrollment + record ID across both
-- kinds. Records stay "held" until P3/P5 verify what they cite. No sale, stock, cash or refund effect.

CREATE TABLE "offline_support_record" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "terminal_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "key_id" VARCHAR(128) NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "record_id" UUID NOT NULL,
    "record_hash" CHAR(64) NOT NULL,
    "envelope" JSONB NOT NULL,
    "staff_sign_in_id" UUID NOT NULL,
    "work_session_id" UUID NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL,
    "sale_command_id" UUID,
    "recorded_by_user_id" UUID,
    "incident_category" VARCHAR(32),
    "description" VARCHAR(1000),
    "attempt_id" UUID,
    "checkout_draft_id" UUID,
    "reviewed_sale_digest" CHAR(64),
    "amount_minor" BIGINT,
    "card_state" VARCHAR(16),
    "provider_reference" VARCHAR(64),
    "approval_code" VARCHAR(32),
    "approved_at" TIMESTAMP(3),
    "verified_by_user_id" UUID,
    "status" VARCHAR(16) NOT NULL DEFAULT 'held',
    "held_reason" VARCHAR(64),
    "verified_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_by_user_id" UUID NOT NULL,

    CONSTRAINT "offline_support_record_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "offline_support_conflict" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "terminal_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "key_id" VARCHAR(128) NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "record_id" UUID NOT NULL,
    "record_hash" CHAR(64) NOT NULL,
    "original_record_hash" CHAR(64) NOT NULL,
    "envelope" JSONB NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_by_user_id" UUID NOT NULL,

    CONSTRAINT "offline_support_conflict_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "offline_support_record_tenant_id_enrollment_id_record_id_key" ON "offline_support_record"("tenant_id", "enrollment_id", "record_id");
CREATE INDEX "offline_support_record_tenant_id_enrollment_id_attempt_id_idx" ON "offline_support_record"("tenant_id", "enrollment_id", "attempt_id");
CREATE INDEX "offline_support_record_tenant_id_branch_id_status_idx" ON "offline_support_record"("tenant_id", "branch_id", "status");
CREATE UNIQUE INDEX "offline_support_conflict_record_content_key" ON "offline_support_conflict"("tenant_id", "enrollment_id", "record_id", "record_hash");

ALTER TABLE "offline_support_record" ADD CONSTRAINT "offline_support_record_enrollment_fkey" FOREIGN KEY ("tenant_id", "branch_id", "terminal_id", "enrollment_id", "key_id") REFERENCES "terminal_enrollment"("tenant_id", "branch_id", "terminal_id", "id", "key_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "offline_support_conflict" ADD CONSTRAINT "offline_support_conflict_enrollment_fkey" FOREIGN KEY ("tenant_id", "branch_id", "terminal_id", "enrollment_id", "key_id") REFERENCES "terminal_enrollment"("tenant_id", "branch_id", "terminal_id", "id", "key_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Each kind fills exactly its own columns; card-attempt states carry exactly their own evidence.
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
        OR (card_state = 'linked_to_sale'
          AND provider_reference IS NOT NULL AND sale_command_id IS NOT NULL
          AND approval_code IS NULL AND approved_at IS NULL AND verified_by_user_id IS NULL)
      ))
  )
);
ALTER TABLE offline_support_conflict ADD CONSTRAINT offline_support_conflict_shape CHECK (
  record_hash ~ '^[0-9a-f]{64}$' AND original_record_hash ~ '^[0-9a-f]{64}$'
  AND record_hash <> original_record_hash
);

-- Evidence: the signed content never changes and is never deleted. Only the verification outcome
-- moves, once, from held to accepted/rejected.
CREATE FUNCTION pc_preserve_offline_support_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE outcome text[] := ARRAY['status', 'held_reason', 'verified_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Offline support records must be retained'; END IF;
  IF (to_jsonb(NEW) - outcome) IS DISTINCT FROM (to_jsonb(OLD) - outcome)
     OR (OLD.status <> 'held' AND ROW(NEW.status, NEW.held_reason, NEW.verified_at)
       IS DISTINCT FROM ROW(OLD.status, OLD.held_reason, OLD.verified_at)) THEN
    RAISE EXCEPTION 'Offline support record content and verification outcome are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_offline_support_record BEFORE UPDATE OR DELETE ON offline_support_record
  FOR EACH ROW EXECUTE FUNCTION pc_preserve_offline_support_record();

CREATE FUNCTION pc_preserve_offline_support_conflict() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Conflicting support uploads are immutable and must be retained';
END;
$$;
CREATE TRIGGER preserve_offline_support_conflict BEFORE UPDATE OR DELETE ON offline_support_conflict
  FOR EACH ROW EXECUTE FUNCTION pc_preserve_offline_support_conflict();

CREATE POLICY pc_tenant_isolation ON offline_support_record
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pc_tenant_isolation ON offline_support_conflict
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- RLS remains disabled, consistent with the staged inventory.
