import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from "class-validator";

export class HoldSaleDto {
  /** Free-text tag the cashier can recognise ("Blue shirt", "Mr. Perera"). */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  itemCount!: number;

  /** Cart grand total at hold time (decimal string) — display only. */
  @IsString()
  total!: string;

  /** Opaque cart snapshot restored verbatim on recall. */
  @IsArray()
  @ArrayMinSize(1)
  @IsObject({ each: true })
  lines!: Record<string, unknown>[];

  @IsOptional()
  @IsObject()
  meta?: Record<string, unknown>;
}
