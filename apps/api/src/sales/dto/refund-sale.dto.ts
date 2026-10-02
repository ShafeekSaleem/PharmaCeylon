import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { PaymentMethod } from "@prisma/client";
import { PharmacistApprovalDto } from "./pharmacist-approval.dto";

export const REFUND_DISPOSITIONS = ["restock", "quarantine"] as const;
export type RefundDisposition = (typeof REFUND_DISPOSITIONS)[number];

export class RefundSaleItemDto {
  @IsUUID()
  productId!: string;

  @IsUUID()
  batchId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;

  /**
   * Back on the shelf, or held in quarantine for a pharmacist to inspect. Omitted, controlled and
   * prescription items are held and everything else restocks.
   */
  @IsOptional()
  @IsIn(REFUND_DISPOSITIONS)
  disposition?: RefundDisposition;
}

export class RefundSaleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  /** Omit to refund all remaining returnable qty on the invoice. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RefundSaleItemDto)
  items?: RefundSaleItemDto[];

  @IsOptional()
  @IsEnum(PaymentMethod)
  refundMethod?: PaymentMethod;

  /** When set, must equal the computed refund total for the selected lines. */
  @IsOptional()
  @IsString()
  refundAmount?: string;

  /**
   * An approver's till PIN, for a refund over the tenant's threshold when the person refunding
   * may not approve it themselves.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => PharmacistApprovalDto)
  approval?: PharmacistApprovalDto;
}
