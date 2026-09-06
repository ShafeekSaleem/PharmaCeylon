-- Mark the NMRA-derived tags as system tags on tenants that predate the flag.
--
-- Catalog Management separates "tags the pharmacy created" from "regulatory attributes the
-- register states", and the split reads `product_tag.is_system`. Tenants whose tags were created
-- before that column existed carry the register's ten tags as ordinary, editable rows — so they
-- show up in the user list complete with a Rename and a Delete for a control that does not
-- really exist: deleting one drops every assignment the importer owns and the next import only
-- partly rebuilds it.
--
-- This is a flag correction, not a data change: no tag is renamed, merged, deleted, or
-- reassigned, and no product loses a tag. It only says of an existing row what was already true
-- of it. Rollback is `UPDATE product_tag SET is_system = false, canonical_key = NULL` for these
-- ten keys, which restores the previous (incorrect but harmless) editability.
--
-- Matched on exact name, which is what the importer itself uses to find-or-create these rows
-- (see NMRA_TAG_DEFS in nmra-import-merge.ts), so a tenant that renamed one is deliberately left
-- alone rather than having a guess imposed on it.
--
-- `canonical_key` is unique per tenant, so the WHERE clause skips any tenant that already has a
-- correctly-flagged tag for that key — the update is idempotent and safe to re-run.

UPDATE "product_tag" t
   SET "is_system" = true,
       "canonical_key" = defs.canonical_key
  FROM (
    VALUES
      ('NMRA registered',                  'NMRA_REGISTERED'),
      ('Unbranded',                        'NMRA_UNBRANDED'),
      ('SPC / state supply',               'NMRA_SPC_SUPPLY'),
      ('Grocery / Schedule I',             'NMRA_SCHEDULE_I'),
      ('Pharmacy OTC / Schedule II A',     'NMRA_SCHEDULE_IIA'),
      ('Prescription / Schedule II B',     'NMRA_SCHEDULE_IIB'),
      ('Controlled Rx / Schedule II C',    'NMRA_SCHEDULE_IIC'),
      ('Narcotic / Schedule III (Osusala)','NMRA_SCHEDULE_III'),
      ('Prescription required',            'NMRA_PRESCRIPTION_REQUIRED'),
      ('Controlled medicine',              'NMRA_CONTROLLED')
  ) AS defs(name, canonical_key)
 WHERE t."name" = defs.name
   AND t."is_system" = false
   AND t."canonical_key" IS NULL
   -- Leave the tenant alone if it already has a properly flagged tag for this key; two rows
   -- cannot share it, and the correctly-flagged one is the importer's.
   AND NOT EXISTS (
     SELECT 1
       FROM "product_tag" existing
      WHERE existing."tenant_id" = t."tenant_id"
        AND existing."canonical_key" = defs.canonical_key
   );
