import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { StocktakeCondition } from "@prisma/client";

export class StocktakeLineCountDto {
  @IsUUID()
  batchId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  countedQty!: number;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  note?: string | null;

  @IsOptional()
  @IsEnum(StocktakeCondition)
  condition?: StocktakeCondition;
}

export class UpsertStocktakeLinesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => StocktakeLineCountDto)
  lines!: StocktakeLineCountDto[];
}
