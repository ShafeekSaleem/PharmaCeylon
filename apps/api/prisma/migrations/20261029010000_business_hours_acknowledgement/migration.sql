-- P1 #47 / revised D8: idempotent persistence for device-signed after-hours acknowledgements.
-- Additive. The exact signed envelope and its SHA-256 are retained; one record per
-- tenant + enrollment + record ID. Records stay "held" until P3/P5 verify the grant and manager
-- sign-in they cite. No sale, shift, stock or cash effect.

CREATE TABLE "business_hours_acknowledgement" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "terminal_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "key_id" VARCHAR(128) NOT NULL,
    "record_id" UUID NOT NULL,
    "record_hash" CHAR(64) NOT NULL,
    "envelope" JSONB NOT NULL,
    "grant_id" UUID NOT NULL,
    "grant_version" INTEGER NOT NULL,
    "nomination_version" INTEGER NOT NULL,
    "offline_session_id" UUID NOT NULL,
    "manager_sign_in_id" UUID NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'held',
    "held_reason" VARCHAR(64),
    "verified_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_by_user_id" UUID NOT NULL,

    CONSTRAINT "business_hours_acknowledgement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "business_hours_acknowledgement_tenant_id_enrollment_id_reco_key" ON "business_hours_acknowledgement"("tenant_id", "enrollment_id", "record_id");
CREATE INDEX "business_hours_acknowledgement_tenant_id_branch_id_starts_a_idx" ON "business_hours_acknowledgement"("tenant_id", "branch_id", "starts_at");

ALTER TABLE "business_hours_acknowledgement" ADD CONSTRAINT "business_hours_acknowledgement_tenant_id_branch_id_termin_fkey" FOREIGN KEY ("tenant_id", "branch_id", "terminal_id", "enrollment_id", "key_id") REFERENCES "terminal_enrollment"("tenant_id", "branch_id", "terminal_id", "id", "key_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE business_hours_acknowledgement ADD CONSTRAINT business_hours_acknowledgement_shape CHECK (
  record_hash ~ '^[0-9a-f]{64}$'
  AND grant_version > 0 AND nomination_version > 0
  AND recorded_at <= starts_at AND starts_at < ends_at
  AND ends_at - starts_at <= interval '24 hours'
  AND length(trim(reason)) > 0
  AND status IN ('held', 'accepted', 'rejected')
  AND (status <> 'held' OR verified_at IS NULL)
  AND (status = 'held' OR verified_at IS NOT NULL)
);

-- Evidence: the signed content never changes and is never deleted. Only the verification outcome
-- moves, once, from held to accepted/rejected.
CREATE FUNCTION pc_preserve_business_hours_acknowledgement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE outcome text[] := ARRAY['status', 'held_reason', 'verified_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Business-hours acknowledgements must be retained'; END IF;
  IF (to_jsonb(NEW) - outcome) IS DISTINCT FROM (to_jsonb(OLD) - outcome)
     OR (OLD.status <> 'held' AND ROW(NEW.status, NEW.held_reason, NEW.verified_at)
       IS DISTINCT FROM ROW(OLD.status, OLD.held_reason, OLD.verified_at)) THEN
    RAISE EXCEPTION 'Business-hours acknowledgement content and verification outcome are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_business_hours_acknowledgement BEFORE UPDATE OR DELETE ON business_hours_acknowledgement
  FOR EACH ROW EXECUTE FUNCTION pc_preserve_business_hours_acknowledgement();

CREATE POLICY pc_tenant_isolation ON business_hours_acknowledgement
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- RLS remains disabled, consistent with the staged inventory.
