import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { StocktakeMovementMode, StocktakeScope } from "@prisma/client";

export class CreateStocktakeDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  title?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  areaLabel?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  /** When true (default), seed lines based on scope filters. */
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  seedLines?: boolean;

  @IsOptional()
  @IsEnum(StocktakeScope)
  scope?: StocktakeScope;

  /** Hide system qty from counters until completed. */
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  blindCount?: boolean;

  @IsOptional()
  @IsEnum(StocktakeMovementMode)
  movementMode?: StocktakeMovementMode;

  @IsOptional()
  @IsDateString()
  scheduledFor?: string | null;

  @IsOptional()
  @IsDateString()
  expectedCompletionAt?: string | null;

  @IsOptional()
  @IsUUID("4")
  reviewerId?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID("4", { each: true })
  counterIds?: string[];

  /** Used when scope = near_expiry (default 90). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(730)
  nearExpiryDays?: number;

  /** Optional explicit batch list for scope=custom (or to narrow any scope). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID("4", { each: true })
  batchIds?: string[];
}
