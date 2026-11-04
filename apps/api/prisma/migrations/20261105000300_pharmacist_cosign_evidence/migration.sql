-- P1 #47: a registered pharmacist's PIN co-sign for one signed clinical command at a counter.
-- Created online with the PIN (which is checked and never stored), bound to the tenant, branch,
-- counter staff session, the cashier signed in there, the operation and the digest of the exact
-- body. The command carries only this row's ID (`pharmacistEvidenceId`); executing it spends the
-- row once, in the command's own transaction. Additive: no existing row or behaviour changes.

CREATE TABLE "pharmacist_cosign_evidence" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "work_session_id" UUID NOT NULL,
    "staff_user_id" UUID NOT NULL,
    "pharmacist_user_id" UUID NOT NULL,
    "operation" VARCHAR(160) NOT NULL,
    "body_digest" CHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "command_id" UUID,
    "registration_id" UUID,

    CONSTRAINT "pharmacist_cosign_evidence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pharmacist_cosign_evidence_tenant_id_work_session_id_idx"
  ON "pharmacist_cosign_evidence"("tenant_id", "work_session_id");

ALTER TABLE "pharmacist_cosign_evidence" ADD CONSTRAINT "pharmacist_cosign_evidence_tenant_id_branch_id_fkey"
  FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "pharmacist_cosign_evidence" ADD CONSTRAINT "pharmacist_cosign_evidence_work_session_id_fkey"
  FOREIGN KEY ("work_session_id") REFERENCES "terminal_staff_session"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "pharmacist_cosign_evidence" ADD CONSTRAINT "pharmacist_cosign_evidence_tenant_id_pharmacist_user_id_fkey"
  FOREIGN KEY ("tenant_id", "pharmacist_user_id") REFERENCES "tenant_membership"("tenant_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- The registration relied on belongs to the co-signer.
ALTER TABLE "pharmacist_cosign_evidence" ADD CONSTRAINT "pharmacist_cosign_evidence_registration_fkey"
  FOREIGN KEY ("tenant_id", "pharmacist_user_id", "registration_id")
  REFERENCES "pharmacist_registration"("tenant_id", "user_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- One command spends a co-sign, and records which command and registration it was.
CREATE UNIQUE INDEX pharmacist_cosign_evidence_command_key ON pharmacist_cosign_evidence (tenant_id, command_id)
  WHERE command_id IS NOT NULL;
ALTER TABLE pharmacist_cosign_evidence ADD CONSTRAINT pharmacist_cosign_evidence_shape CHECK (
  body_digest ~ '^[0-9a-f]{64}$' AND expires_at > created_at
  AND ((consumed_at IS NULL AND command_id IS NULL AND registration_id IS NULL)
    OR (consumed_at IS NOT NULL AND command_id IS NOT NULL AND registration_id IS NOT NULL))
);

-- Evidence is retained. It is spent once; nothing else changes and nothing is deleted.
CREATE FUNCTION pc_preserve_pharmacist_cosign_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE spend text[] := ARRAY['consumed_at', 'command_id', 'registration_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Pharmacist co-sign evidence must be retained'; END IF;
  IF (to_jsonb(NEW) - spend) IS DISTINCT FROM (to_jsonb(OLD) - spend) OR OLD.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Pharmacist co-sign evidence is immutable once spent';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_pharmacist_cosign_evidence BEFORE UPDATE OR DELETE ON pharmacist_cosign_evidence
  FOR EACH ROW EXECUTE FUNCTION pc_preserve_pharmacist_cosign_evidence();

CREATE POLICY pc_tenant_isolation ON pharmacist_cosign_evidence
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- RLS remains disabled, consistent with the staged inventory.
