import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

/** A widget's saved grid position. `key` is an opaque registry id the
 * frontend owns — the server doesn't validate it against a widget catalog
 * (see dashboard.controller.ts for why that's safe for Phase A widgets).
 * Size isn't user-controlled (no resize), so only position is persisted. */
export class WidgetInstanceDto {
  @IsString()
  @MaxLength(120)
  key!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000)
  x!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000)
  y!: number;
}

export class SaveDashboardLayoutDto {
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => WidgetInstanceDto)
  widgets!: WidgetInstanceDto[];
}
