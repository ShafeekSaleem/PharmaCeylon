-- CreateTable
CREATE TABLE "operational_terminal" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "operational_terminal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "terminal_enrollment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "terminal_id" UUID NOT NULL,
    "key_id" VARCHAR(128) NOT NULL,
    "public_key_hex" CHAR(64) NOT NULL,
    "enrolled_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "revocation_reason" VARCHAR(500),

    CONSTRAINT "terminal_enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "terminal_command_receipt" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "terminal_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "key_id" VARCHAR(128) NOT NULL,
    "command_id" UUID NOT NULL,
    "operation" VARCHAR(160) NOT NULL,
    "request_digest" CHAR(64) NOT NULL,
    "offline_sequence" BIGINT,
    "actor_user_id" UUID NOT NULL,
    "command" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "terminal_command_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "operational_terminal_tenant_id_branch_id_id_key" ON "operational_terminal"("tenant_id", "branch_id", "id");

-- CreateIndex
CREATE INDEX "terminal_enrollment_tenant_id_branch_id_terminal_id_idx" ON "terminal_enrollment"("tenant_id", "branch_id", "terminal_id");

-- CreateIndex
CREATE UNIQUE INDEX "terminal_enrollment_tenant_id_key_id_key" ON "terminal_enrollment"("tenant_id", "key_id");

-- CreateIndex
CREATE UNIQUE INDEX "terminal_enrollment_tenant_id_branch_id_terminal_id_id_key__key" ON "terminal_enrollment"("tenant_id", "branch_id", "terminal_id", "id", "key_id");

-- CreateIndex
CREATE INDEX "terminal_command_receipt_tenant_id_branch_id_recorded_at_idx" ON "terminal_command_receipt"("tenant_id", "branch_id", "recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "terminal_command_receipt_tenant_id_enrollment_id_command_id_key" ON "terminal_command_receipt"("tenant_id", "enrollment_id", "command_id");

-- CreateIndex
CREATE UNIQUE INDEX "terminal_command_receipt_tenant_id_enrollment_id_offline_se_key" ON "terminal_command_receipt"("tenant_id", "enrollment_id", "offline_sequence");

-- CreateIndex
CREATE UNIQUE INDEX "branch_tenant_id_id_key" ON "branch"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "operational_terminal" ADD CONSTRAINT "operational_terminal_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "terminal_enrollment" ADD CONSTRAINT "terminal_enrollment_tenant_id_branch_id_terminal_id_fkey" FOREIGN KEY ("tenant_id", "branch_id", "terminal_id") REFERENCES "operational_terminal"("tenant_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "terminal_command_receipt" ADD CONSTRAINT "terminal_command_receipt_tenant_id_branch_id_terminal_id_e_fkey" FOREIGN KEY ("tenant_id", "branch_id", "terminal_id", "enrollment_id", "key_id") REFERENCES "terminal_enrollment"("tenant_id", "branch_id", "terminal_id", "id", "key_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Additional invariants Prisma cannot express. Revocation does not delete keys or
-- receipts: a disconnected device's earlier journal still needs reconciliation.
ALTER TABLE "terminal_enrollment"
  ADD CONSTRAINT "terminal_enrollment_public_key_check" CHECK (public_key_hex ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "terminal_enrollment_key_id_check" CHECK (length(trim(key_id)) > 0),
  ADD CONSTRAINT "terminal_enrollment_revocation_check" CHECK (
    (revoked_at IS NULL AND revocation_reason IS NULL) OR
    (revoked_at IS NOT NULL AND revoked_at >= created_at AND length(trim(revocation_reason)) > 0 AND revocation_reason IS NOT NULL)
  );
ALTER TABLE "operational_terminal"
  ADD CONSTRAINT "operational_terminal_label_check" CHECK (length(trim(label)) > 0),
  ADD CONSTRAINT "operational_terminal_retirement_check" CHECK (retired_at IS NULL OR retired_at >= created_at);
ALTER TABLE "terminal_command_receipt"
  ADD CONSTRAINT "terminal_receipt_digest_check" CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "terminal_receipt_sequence_check" CHECK (offline_sequence IS NULL OR offline_sequence BETWEEN 1 AND 9007199254740991),
  ADD CONSTRAINT "terminal_receipt_operation_check" CHECK (length(trim(operation)) > 0),
  ADD CONSTRAINT "terminal_receipt_payload_check" CHECK (jsonb_typeof(command) = 'object' AND jsonb_typeof(result) = 'object');

CREATE UNIQUE INDEX "terminal_enrollment_one_active_key" ON "terminal_enrollment" (tenant_id, terminal_id) WHERE revoked_at IS NULL;

CREATE FUNCTION pc_preserve_terminal_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Terminal identity history must be retained';
  END IF;
  IF TG_TABLE_NAME = 'operational_terminal' THEN
    IF ROW(NEW.id, NEW.tenant_id, NEW.branch_id, NEW.created_at) IS DISTINCT FROM
       ROW(OLD.id, OLD.tenant_id, OLD.branch_id, OLD.created_at)
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
CREATE TRIGGER preserve_operational_terminal BEFORE UPDATE OR DELETE ON operational_terminal
  FOR EACH ROW EXECUTE FUNCTION pc_preserve_terminal_identity();
CREATE TRIGGER preserve_terminal_enrollment BEFORE UPDATE OR DELETE ON terminal_enrollment
  FOR EACH ROW EXECUTE FUNCTION pc_preserve_terminal_identity();

CREATE FUNCTION pc_preserve_terminal_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Terminal command receipts are append-only';
END;
$$;
CREATE TRIGGER preserve_terminal_receipt BEFORE UPDATE OR DELETE ON terminal_command_receipt
  FOR EACH ROW EXECUTE FUNCTION pc_preserve_terminal_receipt();

-- Follow the existing staged RLS inventory. Do not enable RLS in this migration.
DO $policies$
DECLARE target_table text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY['operational_terminal', 'terminal_enrollment', 'terminal_command_receipt'] LOOP
    EXECUTE format('CREATE POLICY pc_tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', target_table);
  END LOOP;
END;
$policies$;
