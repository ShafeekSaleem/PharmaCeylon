import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Min } from "class-validator";

export class StockAdjustmentDto {
  @IsUUID()
  productId!: string;

  @IsOptional()
  @IsUUID()
  batchId?: string | null;

  @IsIn(["adjustment_in", "adjustment_out"])
  movementType!: "adjustment_in" | "adjustment_out";

  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;

  @IsOptional()
  @IsString()
  reason?: string;
}
