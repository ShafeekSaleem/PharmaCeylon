import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from "class-validator";
import { CatalogTaskStatus, CatalogTaskType } from "@prisma/client";

/** Cross-cutting views over the queue that aren't a single type or status. */
export const CATALOG_TASK_VIEWS = [
  "all",
  "compliance",
  "ambiguous",
  "no_suggestion",
  "safe",
] as const;
export type CatalogTaskViewKey = (typeof CATALOG_TASK_VIEWS)[number];

/**
 * Query filters for the Work Queue. Arrays arrive comma-separated (`?type=NMRA_MATCH,MISSING_CATEGORY`)
 * because that is what a URL-driven filter bar produces; `@Transform` would hide that, so the
 * splitting is done explicitly in the controller and this DTO takes the parsed shape.
 */
export class ListCatalogTasksDto {
  @IsOptional()
  @IsArray()
  @IsEnum(CatalogTaskStatus, { each: true })
  status?: CatalogTaskStatus[];

  @IsOptional()
  @IsArray()
  @IsEnum(CatalogTaskType, { each: true })
  type?: CatalogTaskType[];

  @IsOptional()
  @IsString()
  view?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsUUID()
  importId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  source?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  createdFrom?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  createdTo?: Date;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  take?: number;
}

export class ApplyCatalogTaskDto {
  /** Choose a different category than the suggested one. MISSING_CATEGORY tasks only. */
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  /** Choose a different register entry than the suggested one. NMRA tasks only. */
  @IsOptional()
  @IsUUID()
  referenceProductId?: string;
}

export class CloseCatalogTaskDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** "Apply safe changes" over whatever the operator currently has filtered. */
export class ApplySafeCatalogTasksDto extends ListCatalogTasksDto {
  /**
   * Belt and braces: the client sends the count it displayed, and a mismatch is reported back
   * rather than silently applying a different number of changes than the button promised.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expected?: number;
}

export class RefreshCatalogTasksDto {
  @IsOptional()
  @IsUUID()
  importId?: string;

  @IsOptional()
  @IsBoolean()
  full?: boolean;
}
