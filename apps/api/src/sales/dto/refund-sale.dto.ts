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

/** Why a customer brought something back — a list, so refunds can be counted by reason. */
export const REFUND_REASONS = [
  "wrong_item",
  "changed_mind",
  "damaged",
  "expired",
  "adverse_reaction",
  "other",
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

export const REFUND_REASON_LABELS: Record<RefundReason, string> = {
  wrong_item: "Wrong item",
  changed_mind: "Changed their mind",
  damaged: "Damaged",
  expired: "Expired or short-dated",
  adverse_reaction: "Adverse reaction",
  other: "Other",
};
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
  /** Why, from the list. Either this or a typed `reason` is required; "other" needs the note. */
  @IsOptional()
  @IsIn(REFUND_REASONS)
  reasonCode?: RefundReason;

  /** A note, or the whole reason for callers that don't send a code. */
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

  /**
   * An approver's till PIN, for a refund over the tenant's threshold when the person refunding
   * may not approve it themselves.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => PharmacistApprovalDto)
  approval?: PharmacistApprovalDto;
}
