-- Import-managed tags become un-editable.
--
-- The Tags screen listed the ten NMRA-derived tags alongside a pharmacy's own with an
-- unguarded delete on all of them. Deleting "NMRA registered" dropped 6,577 assignments the
-- importer owns and would only partly rebuild on the next refresh. `is_system` locks them;
-- `canonical_key` gives each a stable identity so a future display-name change can't orphan it.

ALTER TABLE "product_tag" ADD COLUMN "is_system" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "product_tag" ADD COLUMN "canonical_key" TEXT;

-- Backfill by the names the NMRA importer has always written (see NMRA_TAG_DEFS). Matching on
-- name is safe here and only here: these rows have never been renameable.
UPDATE "product_tag" SET "is_system" = true, "canonical_key" = v.key
FROM (VALUES
  ('NMRA registered',                   'NMRA_REGISTERED'),
  ('Unbranded',                         'NMRA_UNBRANDED'),
  ('SPC / state supply',                'NMRA_SPC_SUPPLY'),
  ('Grocery / Schedule I',              'NMRA_SCHEDULE_I'),
  ('Pharmacy OTC / Schedule II A',      'NMRA_SCHEDULE_IIA'),
  ('Prescription / Schedule II B',      'NMRA_SCHEDULE_IIB'),
  ('Controlled Rx / Schedule II C',     'NMRA_SCHEDULE_IIC'),
  ('Narcotic / Schedule III (Osusala)', 'NMRA_SCHEDULE_III'),
  ('Prescription required',             'NMRA_PRESCRIPTION_REQUIRED'),
  ('Controlled medicine',               'NMRA_CONTROLLED')
) AS v(name, key)
WHERE "product_tag"."name" = v.name;

CREATE UNIQUE INDEX "product_tag_tenant_id_canonical_key_key"
  ON "product_tag"("tenant_id", "canonical_key");
CREATE INDEX "product_tag_tenant_id_is_system_idx"
  ON "product_tag"("tenant_id", "is_system");
