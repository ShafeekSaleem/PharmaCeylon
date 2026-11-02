-- P2: local-attendance proofs. Desktop main signs what it saw of the Windows session (physical
-- console or not) against one live terminal challenge; the server keeps it unconsumed until
-- LocalAttendanceVerifier consumes it once inside the enrollment/session/command transaction.
CREATE TABLE "terminal_attendance_proof" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "challenge_id" UUID NOT NULL,
    "purpose" VARCHAR(24) NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "terminal_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "key_id" VARCHAR(128) NOT NULL,
    "register_id" UUID NOT NULL,
    "till_id" UUID NOT NULL,
    "payload_digest" CHAR(64) NOT NULL,
    "attestation_digest" CHAR(64) NOT NULL,
    "attestation" JSONB NOT NULL,
    "session_protocol" VARCHAR(16) NOT NULL,
    "windows_session_id" INTEGER NOT NULL,
    "app_version" VARCHAR(64) NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "terminal_attendance_proof_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "terminal_attendance_proof_tenant_id_branch_id_expires_at_idx" ON "terminal_attendance_proof"("tenant_id", "branch_id", "expires_at");
CREATE INDEX "terminal_attendance_proof_challenge_id_idx" ON "terminal_attendance_proof"("challenge_id");

ALTER TABLE "terminal_attendance_proof" ADD CONSTRAINT "terminal_attendance_proof_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "terminal_challenge"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "terminal_attendance_proof" ADD CONSTRAINT "terminal_attendance_proof_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Only a physical console session is ever stored; remote and unknown sessions are refused first.
ALTER TABLE terminal_attendance_proof ADD CONSTRAINT terminal_attendance_proof_shape_check CHECK (
  purpose IN ('enrollment', 'session', 'command') AND session_protocol = 'console'
  AND windows_session_id >= 0 AND payload_digest ~ '^[0-9a-f]{64}$'
  AND attestation_digest ~ '^[0-9a-f]{64}$' AND jsonb_typeof(attestation) = 'object'
  AND length(trim(app_version)) > 0
  AND expires_at > created_at AND (consumed_at IS NULL OR consumed_at >= created_at)
);

-- Same rule as challenges: content is immutable, consumption is recorded once, nothing is deleted.
CREATE TRIGGER preserve_terminal_attendance_proof BEFORE UPDATE OR DELETE ON terminal_attendance_proof
  FOR EACH ROW EXECUTE FUNCTION pc_preserve_terminal_trust_binding();

CREATE POLICY pc_tenant_isolation ON terminal_attendance_proof
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- RLS remains disabled, consistent with the staged inventory.
