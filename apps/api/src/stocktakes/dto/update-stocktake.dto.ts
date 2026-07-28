import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { StocktakeVarianceReason } from "@prisma/client";
import { Type } from "class-transformer";

export class UpdateStocktakeDto {
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
  @IsUUID("4", { each: true })
  counterIds?: string[];
}

export class AddStocktakeLinesDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID("4", { each: true })
  batchIds!: string[];
}

export class RemoveStocktakeLinesDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID("4", { each: true })
  batchIds!: string[];
}

export class RequestRecountDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID("4", { each: true })
  lineIds!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(512)
  note?: string | null;
}

export class ReviewStocktakeLineDto {
  @IsUUID("4")
  lineId!: string;

  @IsOptional()
  @IsEnum(StocktakeVarianceReason)
  reviewReason?: StocktakeVarianceReason | null;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  reviewResolution?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  reviewNote?: string | null;
}

export class ReviewStocktakeLinesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReviewStocktakeLineDto)
  lines!: ReviewStocktakeLineDto[];
}
