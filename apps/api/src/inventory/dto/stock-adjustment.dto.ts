import { Type } from "class-transformer";
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";

export class NewBatchForAdjustmentDto {
  @IsString()
  @MaxLength(64)
  batchNo!: string;

  @IsDateString()
  expiryDate!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  costPrice!: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  sellingPrice!: number;

  /** Optional — not every opening-stock/adjustment batch has a known supplier, but capturing it
   *  when the person entering the adjustment does know it keeps supplier-side reporting
   *  (Near Expiry, Supplier Spend/Performance) able to find this batch later. */
  @IsOptional()
  @IsUUID()
  supplierId?: string;
}

export class StockAdjustmentDto {
  @IsUUID()
  productId!: string;

  /** Existing batch. Required for adjustment_out; optional for adjustment_in when newBatch is provided. */
  @ValidateIf((o: StockAdjustmentDto) => !o.newBatch)
  @IsUUID()
  batchId?: string;

  /** Create a batch and post opening stock (adjustment_in only). */
  @IsOptional()
  @ValidateNested()
  @Type(() => NewBatchForAdjustmentDto)
  newBatch?: NewBatchForAdjustmentDto;

  @IsIn(["adjustment_in", "adjustment_out"])
  movementType!: "adjustment_in" | "adjustment_out";

  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  reason?: string;
}
