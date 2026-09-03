import { Type } from "class-transformer";
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from "class-validator";
import type { CatalogSource } from "@prisma/client";
import { ProductRelationsDto } from "./product-relations.dto";

const CATALOG_SOURCES: CatalogSource[] = ["NMRA", "MANUAL", "SUPPLIER", "CSV_IMPORT", "BARCODE"];

export class CreateProductDto extends ProductRelationsDto {
  @IsString()
  @MaxLength(64)
  sku!: string;

  /**
   * Catalog record origin. Defaults to MANUAL — NMRA-specific fields (schedule, regType,
   * dossierNo, registrationNo/Date) are only required/expected when source = NMRA, so retail
   * items (chocolate, diapers, shampoo, …) never need to fake pharmaceutical regulatory data.
   */
  @IsOptional()
  @IsIn(CATALOG_SOURCES)
  /**
   * @deprecated Provenance, not an attribute — the server sets it from the code path that
   * created the record (MANUAL here, NMRA / CSV_IMPORT in the importers). Still accepted so an
   * older client doesn't break, but the value is ignored.
   */
  source?: CatalogSource;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  barcode?: string | null;

  @IsString()
  @MaxLength(512)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  brandName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  genericName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  manufacturer?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  dosageForm?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  strength?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  unit?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  packSize?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  packType?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  storage?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  shelfLife?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  taxCategory?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  imageUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  registrationNo?: string | null;

  @IsOptional()
  @IsDateString()
  registrationDate?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  schedule?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  regType?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  dossierNo?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  countryOfOrigin?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  localAgent?: string | null;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isControlled?: boolean;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  requiresPrescription?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  reorderLevel?: number;
}
