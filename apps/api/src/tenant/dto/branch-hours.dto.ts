import { Type } from "class-transformer";
import {
  IsBoolean,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from "class-validator";

/** PUT /tenant/branches/:branchId/hours — replaces the whole hours document. */
export class UpdateBranchHoursDto {
  /** The `version` the editor loaded; a stale one is refused instead of overwriting. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  /** A `BranchHours` document. Its shape is checked by `validateBranchHours` (shared), which
   *  refuses unknown fields — class-validator only confirms it's an object. */
  @IsObject()
  hours!: Record<string, unknown>;

  /** Second confirmation, required when this save turns mandatory limits into "no selling". */
  @IsOptional()
  @IsBoolean()
  confirmNoSelling?: boolean;
}

export class CreateBranchHoursExtensionDto {
  @IsISO8601({ strict: true })
  startsAt!: string;

  @IsISO8601({ strict: true })
  endsAt!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class RevokeBranchHoursExtensionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
