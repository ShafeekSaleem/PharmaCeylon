import { Type } from "class-transformer";
import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from "class-validator";
import { ProductRelationsDto } from "./product-relations.dto";

export class UpdateProductDto extends ProductRelationsDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  barcode?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  name?: string;

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

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isActive?: boolean;
}
