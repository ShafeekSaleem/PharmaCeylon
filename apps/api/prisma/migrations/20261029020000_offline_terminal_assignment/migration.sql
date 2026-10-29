-- P1 #47 / revised D13: owner-controlled offline-terminal assignment, authorized online (remotely
-- if need be), separate from local signed activation on the exact target (P2/P3). Additive; no
-- terminal is nominated and no grant is issued by this migration or by authorization.

CREATE TABLE "offline_terminal_delegation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "manager_user_id" UUID NOT NULL,
    "delegated_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "revoked_by_user_id" UUID,
    "revocation_reason" VARCHAR(500),

    CONSTRAINT "offline_terminal_delegation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "offline_terminal_assignment_authorization" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "target_terminal_id" UUID NOT NULL,
    "target_enrollment_id" UUID NOT NULL,
    "target_key_id" VARCHAR(128) NOT NULL,
    "expected_nomination_version" INTEGER NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "authorized_by_user_id" UUID NOT NULL,
    "authority" VARCHAR(20) NOT NULL,
    "delegation_id" UUID,
    "authorized_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" VARCHAR(16) NOT NULL DEFAULT 'authorized',
    "revoked_at" TIMESTAMP(3),
    "revoked_by_user_id" UUID,
    "revocation_reason" VARCHAR(500),
    "consumed_at" TIMESTAMP(3),
    "consumed_by_user_id" UUID,

    CONSTRAINT "offline_terminal_assignment_authorization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "offline_terminal_nomination" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "terminal_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "key_id" VARCHAR(128) NOT NULL,
    "version" INTEGER NOT NULL,
    "authorization_id" UUID NOT NULL,
    "activated_at" TIMESTAMP(3) NOT NULL,
    "activated_by_user_id" UUID NOT NULL,

    CONSTRAINT "offline_terminal_nomination_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "offline_terminal_delegation_tenant_id_id_key" ON "offline_terminal_delegation"("tenant_id", "id");
CREATE INDEX "offline_terminal_delegation_tenant_id_branch_id_manager_use_idx" ON "offline_terminal_delegation"("tenant_id", "branch_id", "manager_user_id");
CREATE INDEX "offline_terminal_assignment_authorization_tenant_id_branch__idx" ON "offline_terminal_assignment_authorization"("tenant_id", "branch_id", "authorized_at");
CREATE UNIQUE INDEX "offline_terminal_nomination_tenant_id_branch_id_key" ON "offline_terminal_nomination"("tenant_id", "branch_id");

ALTER TABLE "offline_terminal_delegation" ADD CONSTRAINT "offline_terminal_delegation_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "offline_terminal_assignment_authorization" ADD CONSTRAINT "offline_terminal_assignment_authorization_tenant_id_branch_fkey" FOREIGN KEY ("tenant_id", "branch_id", "target_terminal_id", "target_enrollment_id", "target_key_id") REFERENCES "terminal_enrollment"("tenant_id", "branch_id", "terminal_id", "id", "key_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "offline_terminal_assignment_authorization" ADD CONSTRAINT "offline_terminal_assignment_authorization_tenant_id_delega_fkey" FOREIGN KEY ("tenant_id", "delegation_id") REFERENCES "offline_terminal_delegation"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "offline_terminal_nomination" ADD CONSTRAINT "offline_terminal_nomination_tenant_id_branch_id_terminal_i_fkey" FOREIGN KEY ("tenant_id", "branch_id", "terminal_id", "enrollment_id", "key_id") REFERENCES "terminal_enrollment"("tenant_id", "branch_id", "terminal_id", "id", "key_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- One live delegation per manager and branch; one outstanding authorization per branch.
CREATE UNIQUE INDEX offline_terminal_delegation_active_key ON offline_terminal_delegation (tenant_id, branch_id, manager_user_id)
  WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX offline_terminal_assignment_outstanding_key ON offline_terminal_assignment_authorization (tenant_id, branch_id)
  WHERE status = 'authorized';

ALTER TABLE offline_terminal_delegation ADD CONSTRAINT offline_terminal_delegation_shape CHECK (
  manager_user_id <> delegated_by_user_id
  AND ((revoked_at IS NULL AND revoked_by_user_id IS NULL AND revocation_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL AND length(trim(revocation_reason)) > 0
      AND revoked_at >= created_at))
);
ALTER TABLE offline_terminal_assignment_authorization ADD CONSTRAINT offline_terminal_assignment_shape CHECK (
  expected_nomination_version >= 0
  AND length(trim(reason)) > 0
  AND ((authority = 'owner' AND delegation_id IS NULL) OR (authority = 'delegated_manager' AND delegation_id IS NOT NULL))
  AND ((status = 'authorized' AND revoked_at IS NULL AND consumed_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL
      AND length(trim(revocation_reason)) > 0 AND consumed_at IS NULL)
    OR (status = 'consumed' AND consumed_at IS NOT NULL AND consumed_by_user_id IS NOT NULL AND revoked_at IS NULL))
);
ALTER TABLE offline_terminal_nomination ADD CONSTRAINT offline_terminal_nomination_shape CHECK (version > 0);

-- Authority evidence is retained. A delegation records its revocation once; an authorization
-- moves from authorized to revoked or consumed once; nothing else changes and nothing is deleted.
CREATE FUNCTION pc_preserve_offline_terminal_delegation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revocation text[] := ARRAY['revoked_at', 'revoked_by_user_id', 'revocation_reason'];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Offline-terminal delegations must be retained'; END IF;
  IF (to_jsonb(NEW) - revocation) IS DISTINCT FROM (to_jsonb(OLD) - revocation)
     OR (OLD.revoked_at IS NOT NULL AND ROW(NEW.revoked_at, NEW.revoked_by_user_id, NEW.revocation_reason)
       IS DISTINCT FROM ROW(OLD.revoked_at, OLD.revoked_by_user_id, OLD.revocation_reason)) THEN
    RAISE EXCEPTION 'Delegation content and revocation are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_offline_terminal_delegation BEFORE UPDATE OR DELETE ON offline_terminal_delegation
  FOR EACH ROW EXECUTE FUNCTION pc_preserve_offline_terminal_delegation();

CREATE FUNCTION pc_preserve_offline_terminal_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE outcome text[] := ARRAY['status', 'revoked_at', 'revoked_by_user_id', 'revocation_reason',
  'consumed_at', 'consumed_by_user_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Offline-terminal assignment authorizations must be retained'; END IF;
  IF (to_jsonb(NEW) - outcome) IS DISTINCT FROM (to_jsonb(OLD) - outcome)
     OR (OLD.status <> 'authorized' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
    RAISE EXCEPTION 'Assignment authorization content and outcome are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_offline_terminal_assignment BEFORE UPDATE OR DELETE ON offline_terminal_assignment_authorization
  FOR EACH ROW EXECUTE FUNCTION pc_preserve_offline_terminal_assignment();

CREATE POLICY pc_tenant_isolation ON offline_terminal_delegation
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pc_tenant_isolation ON offline_terminal_assignment_authorization
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pc_tenant_isolation ON offline_terminal_nomination
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- RLS remains disabled, consistent with the staged inventory.
