-- P1 #47: who verified a prescription, not only who typed it. A prescription recorded through the
-- signed counter command keeps the pharmacist whose SLMC registration the command relied on (the
-- PIN co-signer, or the registered pharmacist recording it alone) and that registration. The
-- unsigned browser route checks no registration, so it leaves both null.

ALTER TABLE "prescription" ADD COLUMN "checked_by" UUID;
ALTER TABLE "prescription" ADD COLUMN "checked_registration_id" UUID;

-- Pins the registration to the checker in the tenant. NOT VALID here, validated by the next
-- migration in its own transaction, so deploying doesn't hold a long lock on `prescription`.
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_tenant_id_checked_by_checked_registration_id_fkey"
  FOREIGN KEY ("tenant_id", "checked_by", "checked_registration_id")
  REFERENCES "pharmacist_registration"("tenant_id", "user_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_checked_by_fkey"
  FOREIGN KEY ("checked_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE prescription ADD CONSTRAINT prescription_checked_by_check CHECK (
  (checked_by IS NULL) = (checked_registration_id IS NULL)
) NOT VALID;

-- Prescriptions already recorded through the signed command: their `prescription.recorded` audit
-- carries the command provenance. `pharmacistUserId` exists only from the co-sign change on; before
-- it the registration was always the recorder's own. Only a registration that belongs to that
-- person is copied, so the constraints above hold for every backfilled row.
UPDATE prescription p
SET checked_by = COALESCE(src.cosigner, p.created_by), checked_registration_id = src.registration_id
FROM (
  SELECT DISTINCT ON (a.entity_id)
    a.tenant_id,
    a.entity_id AS prescription_id,
    (a.payload->'command'->>'pharmacistRegistrationId')::uuid AS registration_id,
    NULLIF(a.payload->'command'->>'pharmacistUserId', '')::uuid AS cosigner
  FROM audit_event a
  WHERE a.entity_name = 'prescription' AND a.event_name = 'prescription.recorded'
    AND a.payload->'command'->>'pharmacistRegistrationId' IS NOT NULL
  ORDER BY a.entity_id, a.created_at
) AS src
WHERE p.id = src.prescription_id AND p.tenant_id = src.tenant_id AND p.checked_by IS NULL
  AND EXISTS (SELECT 1 FROM pharmacist_registration pr
    WHERE pr.tenant_id = p.tenant_id AND pr.user_id = COALESCE(src.cosigner, p.created_by)
      AND pr.id = src.registration_id);
