import { Type } from "class-transformer";
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from "class-validator";

export class CreateProductDto {
  @IsString()
  @MaxLength(64)
  sku!: string;

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
  @MaxLength(512)
  imageUrl?: string | null;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isControlled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  reorderLevel?: number;
}
