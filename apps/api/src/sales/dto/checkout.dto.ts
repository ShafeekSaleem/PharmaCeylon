import { PaymentMethod } from "@prisma/client";
import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { PharmacistApprovalDto } from "./pharmacist-approval.dto";

export class CheckoutLineDto {
  @IsUUID()
  productId!: string;

  /** When omitted, checkout auto-picks FEFO (earliest non-expired, non-quarantined batch with stock). */
  @IsOptional()
  @IsUUID()
  batchId?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;

  /** Unit price before line discount/tax (decimal string) */
  @IsString()
  unitPrice!: string;

  @IsOptional()
  @IsString()
  discountAmount?: string;

  @IsOptional()
  @IsString()
  taxAmount?: string;
}

export class CheckoutPaymentDto {
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  /** Tendered amount for this method (decimal string). */
  @IsString()
  amount!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  reference?: string;
}

export class CheckoutDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CheckoutLineDto)
  items!: CheckoutLineDto[];

  @IsOptional()
  @IsUUID()
  customerId?: string;

  /** Required when the cart contains controlled medicines. */
  @IsOptional()
  @IsUUID()
  prescriptionId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  notes?: string;

  /** Tender lines. Omit for an implicit exact-cash sale. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CheckoutPaymentDto)
  payments?: CheckoutPaymentDto[];

  /**
   * Recall reference. `POST /sales/holds/:id/recall` already deletes the hold
   * the moment it's recalled, so this is a defensive cleanup — it only deletes
   * something if the row still exists (e.g. an older client that peeked at the
   * hold via `GET /sales/holds/:id` instead of recalling it).
   */
  @IsOptional()
  @IsUUID()
  heldSaleId?: string;

  /**
   * Cashier co-sign: pharmacist/manager/owner PIN (or login password if no till PIN).
   * Required when the cart has controlled items and the cashier is not an approver.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => PharmacistApprovalDto)
  pharmacistApproval?: PharmacistApprovalDto;
}
