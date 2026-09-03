import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from "class-validator";

export const BULK_PRODUCT_ACTIONS = [
  "range",
  "unrange",
  "activate",
  "deactivate",
] as const;

export type BulkProductAction = (typeof BULK_PRODUCT_ACTIONS)[number];

/** Explicit-id ceiling — the page-selection path never exceeds one page of results. */
export const BULK_PRODUCT_ID_LIMIT = 1000;

/**
 * The "select all N matching" path. Same filter shape as `GET /products`, resolved to ids
 * server-side so a pharmacy can fix an over-broad import in one action instead of paging
 * through it. Bounded by `BULK_PRODUCT_MATCH_LIMIT` in the service.
 */
export class BulkProductFilterDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  dosageForm?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  brandName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  schedule?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  isControlled?: string;

  @IsOptional()
  @IsBoolean()
  requiresPrescription?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  rangeStatus?: string;

  @IsOptional()
  @IsBoolean()
  lowStock?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  commercialCategoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  tagId?: string;
}

export class BulkProductsDto {
  @IsIn(BULK_PRODUCT_ACTIONS)
  action!: BulkProductAction;

  /** Explicit selection. Mutually exclusive with `filter`. */
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(BULK_PRODUCT_ID_LIMIT)
  @IsUUID("4", { each: true })
  productIds?: string[];

  /** Everything matching the current list filters. Mutually exclusive with `productIds`. */
  @IsOptional()
  @ValidateNested()
  @Type(() => BulkProductFilterDto)
  filter?: BulkProductFilterDto;
}
