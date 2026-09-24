import { Type } from "class-transformer";
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from "class-validator";

export class UpsertSupplierPriceDto {
  @IsUUID()
  productId!: string;

  /** The supplier's own code for the product, as printed on their invoices. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  supplierSku?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  unitsPerPack?: number;

  /** Decimal string. Either a pack cost or a unit cost must be given. */
  @IsOptional()
  @IsString()
  packCost?: string | null;

  @IsOptional()
  @IsString()
  unitCost?: string | null;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  @Max(100)
  discountPercent?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}
