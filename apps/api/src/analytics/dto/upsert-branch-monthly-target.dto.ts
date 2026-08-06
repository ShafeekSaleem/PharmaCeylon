import { Type } from "class-transformer";
import {
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from "class-validator";

export class UpsertBranchMonthlyTargetDto {
  @IsUUID()
  branchId!: string;

  /** YYYY-MM */
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  yearMonth!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  targetAmount!: number;

  @IsOptional()
  @IsUUID()
  managerUserId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  notes?: string | null;
}
