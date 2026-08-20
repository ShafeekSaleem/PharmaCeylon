-- Catalog taxonomy redesign: separate commercial (merchandising) categories from
-- import-derived regulatory classification facets (Dosage Form / NMRA Schedule /
-- Registration Type). See root CLAUDE.md / docs for the architecture writeup.

-- CreateEnum
CREATE TYPE "CategoryDimension" AS ENUM ('COMMERCIAL', 'DOSAGE_FORM', 'NMRA_SCHEDULE', 'REGISTRATION_TYPE');

-- CreateEnum
CREATE TYPE "CategorySource" AS ENUM ('SYSTEM_TEMPLATE', 'NMRA_IMPORT', 'TENANT', 'AUTO_CLASSIFIED');

-- CreateEnum
CREATE TYPE "CategoryAssignmentSource" AS ENUM ('NMRA_IMPORT', 'MANUAL', 'AUTO_CLASSIFIED', 'SYSTEM_DEFAULT');

-- CreateEnum
CREATE TYPE "CatalogSource" AS ENUM ('NMRA', 'MANUAL', 'SUPPLIER', 'CSV_IMPORT', 'BARCODE');

-- AlterTable: product.source (default MANUAL so existing rows are valid, then backfill NMRA below)
ALTER TABLE "product" ADD COLUMN "source" "CatalogSource" NOT NULL DEFAULT 'MANUAL';

-- CreateIndex
CREATE INDEX "product_tenant_id_source_idx" ON "product"("tenant_id", "source");

-- Backfill: every existing product with an NMRA registration number came from the NMRA import.
UPDATE "product" SET "source" = 'NMRA' WHERE "registration_no" IS NOT NULL;

-- AlterTable: product_category new taxonomy metadata
ALTER TABLE "product_category" ADD COLUMN "dimension" "CategoryDimension" NOT NULL DEFAULT 'DOSAGE_FORM';
ALTER TABLE "product_category" ADD COLUMN "canonical_key" TEXT;
ALTER TABLE "product_category" ADD COLUMN "source" "CategorySource" NOT NULL DEFAULT 'TENANT';
ALTER TABLE "product_category" ADD COLUMN "is_system" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "product_category" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "product_category" ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "product_category" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill dimension/source/is_system for existing rows by walking each row up to its root
-- ancestor: the three NMRA-created roots ("Dosage form" / "NMRA Schedule" / "Registration
-- type") and their descendants become the matching regulatory dimension; anything else
-- (legacy tenant-created categories, which previously had no merchandising/regulatory
-- distinction) becomes COMMERCIAL, since merchandising was their only plausible purpose.
WITH RECURSIVE ancestry AS (
  SELECT "id", "id" AS root_id, "name" AS root_name
  FROM "product_category"
  WHERE "parent_category_id" IS NULL
  UNION ALL
  SELECT pc."id", a.root_id, a.root_name
  FROM "product_category" pc
  JOIN ancestry a ON pc."parent_category_id" = a."id"
)
UPDATE "product_category" pc
SET
  "dimension" = CASE a.root_name
    WHEN 'Dosage form' THEN 'DOSAGE_FORM'::"CategoryDimension"
    WHEN 'NMRA Schedule' THEN 'NMRA_SCHEDULE'::"CategoryDimension"
    WHEN 'Registration type' THEN 'REGISTRATION_TYPE'::"CategoryDimension"
    ELSE 'COMMERCIAL'::"CategoryDimension"
  END,
  "source" = CASE a.root_name
    WHEN 'Dosage form' THEN 'NMRA_IMPORT'::"CategorySource"
    WHEN 'NMRA Schedule' THEN 'NMRA_IMPORT'::"CategorySource"
    WHEN 'Registration type' THEN 'NMRA_IMPORT'::"CategorySource"
    ELSE 'TENANT'::"CategorySource"
  END,
  "is_system" = (a.root_name IN ('Dosage form', 'NMRA Schedule', 'Registration type'))
FROM ancestry a
WHERE pc."id" = a."id";

-- Widen the name-uniqueness constraint to be dimension-aware (a COMMERCIAL and a DOSAGE_FORM
-- category may now legitimately share a name/parent).
DROP INDEX "product_category_tenant_id_name_parent_category_id_key";
CREATE UNIQUE INDEX "product_category_tenant_id_dimension_name_parent_category_id_key" ON "product_category"("tenant_id", "dimension", "name", "parent_category_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_category_tenant_id_canonical_key_key" ON "product_category"("tenant_id", "canonical_key");
CREATE INDEX "product_category_tenant_id_dimension_idx" ON "product_category"("tenant_id", "dimension");
CREATE INDEX "product_category_tenant_id_dimension_is_active_idx" ON "product_category"("tenant_id", "dimension", "is_active");
CREATE INDEX "product_category_tenant_id_canonical_key_idx" ON "product_category"("tenant_id", "canonical_key");

-- AlterTable: product_category_map assignment metadata
ALTER TABLE "product_category_map" ADD COLUMN "dimension" "CategoryDimension";
ALTER TABLE "product_category_map" ADD COLUMN "is_primary" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "product_category_map" ADD COLUMN "assignment_source" "CategoryAssignmentSource" NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "product_category_map" ADD COLUMN "confidence" DECIMAL(4,3);

-- Backfill dimension from the mapped category (denormalized copy — see schema comment).
UPDATE "product_category_map" pcm
SET "dimension" = pc."dimension"
FROM "product_category" pc
WHERE pcm."category_id" = pc."id";

ALTER TABLE "product_category_map" ALTER COLUMN "dimension" SET NOT NULL;

-- Backfill assignment_source: every existing Dosage Form / Schedule / Registration Type map
-- was written by the NMRA import pipeline; existing COMMERCIAL-dimension maps (reclassified
-- legacy tenant categories) were created manually via the category management endpoints.
UPDATE "product_category_map"
SET "assignment_source" = 'NMRA_IMPORT'
WHERE "dimension" IN ('DOSAGE_FORM', 'NMRA_SCHEDULE', 'REGISTRATION_TYPE');

-- Enforce "at most one primary COMMERCIAL category per product" retroactively before adding
-- the partial unique index below: keep the earliest-created COMMERCIAL map per product as
-- primary, demote any others (a product could only have gotten multiple COMMERCIAL maps
-- before this migration via manual assignment to more than one legacy category).
WITH ranked AS (
  SELECT "id",
         ROW_NUMBER() OVER (PARTITION BY "tenant_id", "product_id" ORDER BY "created_at" ASC, "id" ASC) AS rn
  FROM "product_category_map"
  WHERE "dimension" = 'COMMERCIAL'
)
UPDATE "product_category_map" pcm
SET "is_primary" = (ranked.rn = 1)
FROM ranked
WHERE pcm."id" = ranked."id";

-- CreateIndex
CREATE INDEX "product_category_map_tenant_id_category_id_idx" ON "product_category_map"("tenant_id", "category_id");
CREATE INDEX "product_category_map_tenant_id_product_id_dimension_idx" ON "product_category_map"("tenant_id", "product_id", "dimension");

-- Primary-commercial-category invariant, enforced at the database level. NOTE: this is a
-- partial (filtered) unique index — Prisma's schema DSL cannot express a WHERE clause on
-- @@unique, so it is NOT represented in schema.prisma and must be preserved by hand in any
-- future migration that recreates this table. The service layer (ProductMetaService /
-- CategoryTaxonomyService) is the primary enforcement point; this index is the backstop.
CREATE UNIQUE INDEX "product_category_map_primary_commercial_uq" ON "product_category_map"("tenant_id", "product_id") WHERE "is_primary" = true AND "dimension" = 'COMMERCIAL';
