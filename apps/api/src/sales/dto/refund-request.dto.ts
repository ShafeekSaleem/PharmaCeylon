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
  Matches,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { PaymentMethod, SaleRefundRequestStatus } from "@prisma/client";
import { REFUND_REASONS, RefundSaleItemDto, type RefundReason } from "./refund-sale.dto";

/**
 * A refund prepared remotely (D10): what comes back, how much and why. It moves no stock or
 * money; it waits at the counter. Same fields as a till refund, without the till PIN — over the
 * threshold, approval is a separate step.
 */
export class PrepareSaleRefundDto {
  @IsOptional()
  @IsIn(REFUND_REASONS)
  reasonCode?: RefundReason;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  /** Omit to refund all remaining returnable qty on the invoice. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RefundSaleItemDto)
  items?: RefundSaleItemDto[];

  /** One method for the whole refund. Omitted, it goes back the way the sale was paid. */
  @IsOptional()
  @IsEnum(PaymentMethod)
  refundMethod?: PaymentMethod;

  /** When set, must equal the computed refund total for the selected lines. */
  @IsOptional()
  @IsString()
  refundAmount?: string;
}

/** The exact prepared refund the approver saw: `approvalReview` from the request. */
export class ApproveSaleRefundDto {
  @IsUUID()
  approvalId!: string;

  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @Matches(/^[0-9a-f]{64}$/)
  expectedDigest!: string;
}

/** Pins the displayed approval (`executionApprovalId`); null when no approval applies. */
export class ExecuteSaleRefundDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  approvalId?: string | null;
}

export class ListSaleRefundRequestsQueryDto {
  @IsOptional()
  @IsUUID()
  saleId?: string;

  @IsOptional()
  @IsEnum(SaleRefundRequestStatus)
  status?: SaleRefundRequestStatus;
}
