import { Type } from "class-transformer";
import {
  IsBoolean,
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

/**
 * What happened to the stock. Each sets the direction and is stored as the ledger's reason code,
 * so "how much did we lose to damage last month" is a query, not a reading exercise.
 */
export const ADJUSTMENT_KINDS = [
  "found",
  "damaged",
  "expired",
  "lost",
  "opening",
  "correction",
] as const;
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];

export const ADJUSTMENT_KIND_LABELS: Record<AdjustmentKind, string> = {
  found: "Found extra stock",
  damaged: "Damaged",
  expired: "Expired",
  lost: "Lost or missing",
  opening: "Opening stock",
  correction: "Correction",
};

export class StockAdjustmentDto {
  /** What happened. Omitted, `movementType` and a typed `reason` say it, as before. */
  @IsOptional()
  @IsIn(ADJUSTMENT_KINDS)
  kind?: AdjustmentKind;

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

  /** Set by `kind`, except for a correction, which can go either way. */
  @ValidateIf((o: StockAdjustmentDto) => !o.kind || o.kind === "correction")
  @IsIn(["adjustment_in", "adjustment_out"])
  movementType?: "adjustment_in" | "adjustment_out";

  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;

  /**
   * Required for a decrease: a write-off with no recorded reason is exactly the entry an audit
   * can't explain. Optional for an increase.
   */
  @ValidateIf(
    (o: StockAdjustmentDto) =>
      (!o.kind && o.movementType === "adjustment_out") || o.kind === "correction" || o.reason !== undefined,
  )
  @IsString({ message: "Enter a reason for the write-off" })
  @MaxLength(512, { message: "Keep the reason under 512 characters" })
  reason?: string;

  /** Decrease only: write the units off from quarantine (expired or damaged stock being disposed of). */
  @IsOptional()
  @IsBoolean()
  fromQuarantine?: boolean;
}
