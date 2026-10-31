-- P2: one-time enrollment codes. A branch manager issues a code for one counter; whoever is at the
-- new computer redeems it with their own account. Only the SHA-256 of the code is stored.
CREATE TABLE "terminal_enrollment_code" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "register_id" UUID NOT NULL,
    "till_id" UUID NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "used_by_user_id" UUID,
    "enrollment_id" UUID,
    "revoked_at" TIMESTAMP(3),
    "revoked_by_user_id" UUID,

    CONSTRAINT "terminal_enrollment_code_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "terminal_enrollment_code_code_hash_key" ON "terminal_enrollment_code"("code_hash");
CREATE INDEX "terminal_enrollment_code_tenant_id_branch_id_expires_at_idx" ON "terminal_enrollment_code"("tenant_id", "branch_id", "expires_at");

ALTER TABLE "terminal_enrollment_code" ADD CONSTRAINT "terminal_enrollment_code_tenant_id_branch_id_register_id__fkey" FOREIGN KEY ("tenant_id", "branch_id", "register_id", "till_id") REFERENCES "terminal_counter"("tenant_id", "branch_id", "id", "till_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE terminal_enrollment_code ADD CONSTRAINT terminal_enrollment_code_shape_check CHECK (
  code_hash ~ '^[0-9a-f]{64}$' AND expires_at > created_at
  AND expires_at <= created_at + interval '24 hours'
  AND ((used_at IS NULL) = (used_by_user_id IS NULL) AND (used_at IS NULL) = (enrollment_id IS NULL))
  AND ((revoked_at IS NULL) = (revoked_by_user_id IS NULL))
  AND NOT (used_at IS NOT NULL AND revoked_at IS NOT NULL)
);

-- Content is immutable; use and revocation are each recorded once; nothing is deleted.
CREATE FUNCTION pc_preserve_terminal_enrollment_code() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Enrollment code history must be retained'; END IF;
  IF (to_jsonb(NEW) - 'used_at' - 'used_by_user_id' - 'enrollment_id' - 'revoked_at' - 'revoked_by_user_id')
       IS DISTINCT FROM
     (to_jsonb(OLD) - 'used_at' - 'used_by_user_id' - 'enrollment_id' - 'revoked_at' - 'revoked_by_user_id')
     OR (OLD.used_at IS NOT NULL AND ROW(NEW.used_at, NEW.used_by_user_id, NEW.enrollment_id)
         IS DISTINCT FROM ROW(OLD.used_at, OLD.used_by_user_id, OLD.enrollment_id))
     OR (OLD.revoked_at IS NOT NULL AND ROW(NEW.revoked_at, NEW.revoked_by_user_id)
         IS DISTINCT FROM ROW(OLD.revoked_at, OLD.revoked_by_user_id)) THEN
    RAISE EXCEPTION 'Enrollment code content, use and revocation are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_terminal_enrollment_code BEFORE UPDATE OR DELETE ON terminal_enrollment_code
  FOR EACH ROW EXECUTE FUNCTION pc_preserve_terminal_enrollment_code();

CREATE POLICY pc_tenant_isolation ON terminal_enrollment_code
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- RLS remains disabled, consistent with the staged inventory.

-- A challenge issued against a code remembers it, so finishing consumes that exact code.
ALTER TABLE "terminal_challenge" ADD COLUMN "enrollment_code_id" UUID;
ALTER TABLE "terminal_challenge" ADD CONSTRAINT "terminal_challenge_enrollment_code_id_fkey" FOREIGN KEY ("enrollment_code_id") REFERENCES "terminal_enrollment_code"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
