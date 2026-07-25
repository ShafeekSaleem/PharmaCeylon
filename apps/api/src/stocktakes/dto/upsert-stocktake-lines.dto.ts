import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

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
}

export class UpsertStocktakeLinesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => StocktakeLineCountDto)
  lines!: StocktakeLineCountDto[];
}
