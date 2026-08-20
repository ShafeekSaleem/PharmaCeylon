import { IsNumber, IsOptional, Max, Min } from "class-validator";

export class UpdateProfitabilityTargetDto {
  /** Null clears the target (goal tracker reverts to its unset state). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  targetGrossMarginPercent?: number | null;
}
