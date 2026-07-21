import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

export enum CreatePoPriority {
  low = "low",
  normal = "normal",
  high = "high",
  urgent = "urgent",
}

export class PurchaseOrderItemInputDto {
  @IsUUID()
  productId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  orderedQty!: number;

  /** Decimal string e.g. "12.50" */
  @IsString()
  unitCost!: string;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  @Max(100)
  discountPercent?: number;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  @Max(100)
  taxPercent?: number;
}

export class CreatePurchaseOrderDto {
  @IsUUID()
  supplierId!: string;

  @IsOptional()
  @IsDateString()
  expectedOn?: string | null;

  @IsOptional()
  @IsEnum(CreatePoPriority)
  priority?: CreatePoPriority;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  supplierReference?: string | null;

  @IsOptional()
  @IsString()
  notes?: string | null;

  @IsOptional()
  @IsString()
  deliveryInstructions?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  paymentTermsDays?: number;

  /** Decimal string e.g. "500.00" */
  @IsOptional()
  @IsString()
  shippingCharges?: string | null;

  /** When true, create as pending_approval; otherwise draft. */
  @IsOptional()
  @IsBoolean()
  submitForApproval?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderItemInputDto)
  items!: PurchaseOrderItemInputDto[];
}
