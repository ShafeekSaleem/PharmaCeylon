-- P1 #47: a pharmacist's SLMC registration, recorded by an owner. Clinical execution needs a
-- current one (unrevoked, not past its expiry date); roles and permissions never stand in for it.
-- Additive: no existing row or behaviour changes.

CREATE TABLE "pharmacist_registration" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "slmc_number" VARCHAR(32) NOT NULL,
    "expires_on" DATE NOT NULL,
    "recorded_by_user_id" UUID NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "revoked_by_user_id" UUID,
    "revocation_reason" VARCHAR(500),

    CONSTRAINT "pharmacist_registration_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pharmacist_registration_tenant_id_user_id_idx" ON "pharmacist_registration"("tenant_id", "user_id");

ALTER TABLE "pharmacist_registration" ADD CONSTRAINT "pharmacist_registration_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "tenant_membership"("tenant_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- One current registration per staff member, and one person per registration number.
CREATE UNIQUE INDEX pharmacist_registration_current_key ON pharmacist_registration (tenant_id, user_id)
  WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX pharmacist_registration_current_number_key ON pharmacist_registration (tenant_id, slmc_number)
  WHERE revoked_at IS NULL;

ALTER TABLE pharmacist_registration ADD CONSTRAINT pharmacist_registration_shape CHECK (
  slmc_number = upper(btrim(slmc_number)) AND slmc_number ~ '^[A-Z0-9][A-Z0-9/-]{0,31}$'
  AND ((revoked_at IS NULL AND revoked_by_user_id IS NULL AND revocation_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL AND length(btrim(revocation_reason)) > 0
      AND revoked_at >= recorded_at))
);

-- Qualification evidence is retained. A registration records its revocation once; nothing else
-- changes and nothing is deleted.
CREATE FUNCTION pc_preserve_pharmacist_registration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revocation text[] := ARRAY['revoked_at', 'revoked_by_user_id', 'revocation_reason'];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Pharmacist registrations must be retained'; END IF;
  IF (to_jsonb(NEW) - revocation) IS DISTINCT FROM (to_jsonb(OLD) - revocation)
     OR (OLD.revoked_at IS NOT NULL AND ROW(NEW.revoked_at, NEW.revoked_by_user_id, NEW.revocation_reason)
       IS DISTINCT FROM ROW(OLD.revoked_at, OLD.revoked_by_user_id, OLD.revocation_reason)) THEN
    RAISE EXCEPTION 'Registration content and revocation are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_pharmacist_registration BEFORE UPDATE OR DELETE ON pharmacist_registration
  FOR EACH ROW EXECUTE FUNCTION pc_preserve_pharmacist_registration();

CREATE POLICY pc_tenant_isolation ON pharmacist_registration
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- RLS remains disabled, consistent with the staged inventory.
