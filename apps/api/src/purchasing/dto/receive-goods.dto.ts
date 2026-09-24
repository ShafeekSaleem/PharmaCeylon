import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

/** What to do when the batch already exists at a different cost than the one being received. */
export const COST_CONFLICT_CHOICES = ["keep_existing", "update_cost"] as const;
export type CostConflictChoice = (typeof COST_CONFLICT_CHOICES)[number];

/**
 * What to do when the batch already exists with a different expiry.
 *
 * `use_existing` treats it as the same batch and keeps the date already on file — the usual
 * answer, because a batch number and its expiry are printed together on the pack.
 * `correct_existing` rewrites the date, and is only accepted for a batch still awaiting expiry
 * review (an imported placeholder nobody has confirmed). A real expiry that two people disagree
 * about means it is not the same batch, and the answer is a different batch number.
 */
export const EXPIRY_CONFLICT_CHOICES = ["use_existing", "correct_existing"] as const;
export type ExpiryConflictChoice = (typeof EXPIRY_CONFLICT_CHOICES)[number];

export class ReceiveGoodsLineDto {
  @IsUUID()
  productId!: string;

  @IsString()
  batchNo!: string;

  @IsDateString()
  expiryDate!: string;

  /** Good units received and billed for. Optional when `packs` is given. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  receivedQty?: number;

  /** Packs counted at the door; multiplied out by `unitsPerPack`. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  packs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  unitsPerPack?: number;

  /** Bonus units sent at no charge. They reach the shelf with the paid ones. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  freeQty?: number;

  /** Units that arrived damaged. Received, then held in quarantine — never silently dropped. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  rejectedQty?: number;

  /** Why those units were rejected; shown on the held stock in Inventory. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  rejectedReason?: string;

  /** Decimal string. Cost per pack as billed; the unit cost is derived from it. */
  @IsOptional()
  @IsString()
  packCost?: string;

  /** Decimal string. Cost per good unit as billed. */
  @IsOptional()
  @IsString()
  costPrice?: string;

  /** Decimal string */
  @IsString()
  sellingPrice!: string;

  /**
   * Answer to "this batch already exists at a different cost" — the receiver's decision, never
   * the server's guess.
   */
  @IsOptional()
  @IsIn(COST_CONFLICT_CHOICES)
  onCostConflict?: CostConflictChoice;

  /** Answer to "this batch is already on file with a different expiry". */
  @IsOptional()
  @IsIn(EXPIRY_CONFLICT_CHOICES)
  onExpiryConflict?: ExpiryConflictChoice;
}

export class ReceiveGoodsDto {
  @IsUUID()
  purchaseOrderId!: string;

  @IsDateString()
  receivedOn!: string;

  /** The supplier's delivery note number, as printed. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  supplierDeliveryNote?: string;

  /**
   * Accept a delivery that exceeds what was ordered by more than the tenant's tolerance. Only
   * honoured for a caller who may approve purchase orders.
   */
  @IsOptional()
  @IsBoolean()
  acceptOverDelivery?: boolean;

  /**
   * Accept a delivery billed above the agreed price by more than the tenant's tolerance. Only
   * honoured for a caller who may approve purchase orders.
   */
  @IsOptional()
  @IsBoolean()
  acceptPriceVariance?: boolean;

  /**
   * Also move the supplier's agreed price to what was billed, so the next order is raised at
   * the real price instead of repeating the same variance.
   */
  @IsOptional()
  @IsBoolean()
  updateSupplierPrice?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReceiveGoodsLineDto)
  lines!: ReceiveGoodsLineDto[];
}
