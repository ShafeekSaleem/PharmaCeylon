-- AlterTable
-- Nullable counter binding preserves legacy registry rows. The verifier denies use
-- of unbound rows; existing web checkout is not switched to terminal enforcement here.
ALTER TABLE "operational_terminal" ADD COLUMN     "register_id" UUID,
ADD COLUMN     "till_id" UUID;

-- CreateTable
CREATE TABLE "terminal_counter" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "till_id" UUID NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "terminal_counter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "terminal_staff_session" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "terminal_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "key_id" VARCHAR(128) NOT NULL,
    "register_id" UUID NOT NULL,
    "till_id" UUID NOT NULL,
    "staff_user_id" UUID NOT NULL,
    "token_version" INTEGER NOT NULL,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "terminal_staff_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "terminal_challenge" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "purpose" VARCHAR(24) NOT NULL,
    "nonce_hash" CHAR(64) NOT NULL,
    "payload_digest" CHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "terminal_challenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "terminal_counter_tenant_id_branch_id_id_till_id_key" ON "terminal_counter"("tenant_id", "branch_id", "id", "till_id");

-- CreateIndex
CREATE UNIQUE INDEX "terminal_counter_tenant_id_till_id_key" ON "terminal_counter"("tenant_id", "till_id");

-- CreateIndex
CREATE INDEX "terminal_staff_session_tenant_id_branch_id_enrollment_id_idx" ON "terminal_staff_session"("tenant_id", "branch_id", "enrollment_id");

-- CreateIndex
CREATE UNIQUE INDEX "terminal_challenge_nonce_hash_key" ON "terminal_challenge"("nonce_hash");

-- CreateIndex
CREATE INDEX "terminal_challenge_tenant_id_branch_id_expires_at_idx" ON "terminal_challenge"("tenant_id", "branch_id", "expires_at");

-- AddForeignKey
ALTER TABLE "operational_terminal" ADD CONSTRAINT "operational_terminal_tenant_id_branch_id_register_id_till__fkey" FOREIGN KEY ("tenant_id", "branch_id", "register_id", "till_id") REFERENCES "terminal_counter"("tenant_id", "branch_id", "id", "till_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "terminal_counter" ADD CONSTRAINT "terminal_counter_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "terminal_staff_session" ADD CONSTRAINT "terminal_staff_session_tenant_id_branch_id_terminal_id_enr_fkey" FOREIGN KEY ("tenant_id", "branch_id", "terminal_id", "enrollment_id", "key_id") REFERENCES "terminal_enrollment"("tenant_id", "branch_id", "terminal_id", "id", "key_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "terminal_staff_session" ADD CONSTRAINT "terminal_staff_session_tenant_id_branch_id_register_id_til_fkey" FOREIGN KEY ("tenant_id", "branch_id", "register_id", "till_id") REFERENCES "terminal_counter"("tenant_id", "branch_id", "id", "till_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "terminal_challenge" ADD CONSTRAINT "terminal_challenge_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE operational_terminal ADD CONSTRAINT terminal_counter_pair_check
  CHECK ((register_id IS NULL) = (till_id IS NULL));
CREATE UNIQUE INDEX terminal_one_active_counter ON operational_terminal (tenant_id, branch_id, register_id)
  WHERE retired_at IS NULL AND register_id IS NOT NULL;
CREATE UNIQUE INDEX terminal_one_active_staff_session ON terminal_staff_session (tenant_id, till_id)
  WHERE closed_at IS NULL;
ALTER TABLE terminal_staff_session ADD CONSTRAINT terminal_session_dates_check
  CHECK (token_version >= 0 AND (closed_at IS NULL OR closed_at >= opened_at));
ALTER TABLE terminal_counter ADD CONSTRAINT terminal_counter_label_check CHECK (length(trim(label)) > 0);
ALTER TABLE terminal_challenge ADD CONSTRAINT terminal_challenge_shape_check CHECK (
  purpose IN ('enrollment', 'session', 'command') AND nonce_hash ~ '^[0-9a-f]{64}$'
  AND payload_digest ~ '^[0-9a-f]{64}$' AND jsonb_typeof(payload) = 'object'
  AND expires_at > created_at AND (consumed_at IS NULL OR consumed_at >= created_at)
);

-- Extend MR1's identity protection to counter/drawer bindings. No history rebinding.
CREATE OR REPLACE FUNCTION pc_preserve_terminal_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Terminal identity history must be retained'; END IF;
  IF TG_TABLE_NAME = 'operational_terminal' THEN
    IF ROW(NEW.id, NEW.tenant_id, NEW.branch_id, NEW.created_at, NEW.register_id, NEW.till_id) IS DISTINCT FROM
       ROW(OLD.id, OLD.tenant_id, OLD.branch_id, OLD.created_at, OLD.register_id, OLD.till_id)
       OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at) THEN
      RAISE EXCEPTION 'Terminal identity and retirement are immutable';
    END IF;
  ELSE
    IF (to_jsonb(NEW) - 'revoked_at' - 'revocation_reason') IS DISTINCT FROM
       (to_jsonb(OLD) - 'revoked_at' - 'revocation_reason')
       OR (OLD.revoked_at IS NOT NULL AND ROW(NEW.revoked_at, NEW.revocation_reason) IS DISTINCT FROM ROW(OLD.revoked_at, OLD.revocation_reason)) THEN
      RAISE EXCEPTION 'Enrollment identity and revocation are immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION pc_preserve_terminal_trust_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Terminal trust history must be retained'; END IF;
  IF TG_TABLE_NAME = 'terminal_counter' THEN
    IF (to_jsonb(NEW) - 'label' - 'is_active') IS DISTINCT FROM (to_jsonb(OLD) - 'label' - 'is_active') THEN
      RAISE EXCEPTION 'Counter identity is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'terminal_staff_session' THEN
    IF (to_jsonb(NEW) - 'closed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'closed_at')
       OR (OLD.closed_at IS NOT NULL AND NEW.closed_at IS DISTINCT FROM OLD.closed_at) THEN
      RAISE EXCEPTION 'Staff binding and session closure are immutable';
    END IF;
  ELSE
    IF (to_jsonb(NEW) - 'consumed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'consumed_at')
       OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at) THEN
      RAISE EXCEPTION 'Challenge payload and consumption are immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_terminal_counter BEFORE UPDATE OR DELETE ON terminal_counter
  FOR EACH ROW EXECUTE FUNCTION pc_preserve_terminal_trust_binding();
CREATE TRIGGER preserve_terminal_staff_session BEFORE UPDATE OR DELETE ON terminal_staff_session
  FOR EACH ROW EXECUTE FUNCTION pc_preserve_terminal_trust_binding();
CREATE TRIGGER preserve_terminal_challenge BEFORE UPDATE OR DELETE ON terminal_challenge
  FOR EACH ROW EXECUTE FUNCTION pc_preserve_terminal_trust_binding();

DO $policies$
DECLARE target_table text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY['terminal_counter', 'terminal_staff_session', 'terminal_challenge'] LOOP
    EXECUTE format('CREATE POLICY pc_tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', target_table);
  END LOOP;
END;
$policies$;
