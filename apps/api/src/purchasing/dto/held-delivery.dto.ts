import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from "class-validator";
import { ReceiveGoodsDto } from "./receive-goods.dto";

/** The refusals only an approver can lift. */
export const APPROVAL_REQUEST_KINDS = ["over_delivery", "price_variance"] as const;

/** A receiver stopped by a refusal only an approver can lift, sending the delivery they typed. */
export class HoldDeliveryDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(APPROVAL_REQUEST_KINDS, { each: true })
  reasons!: (typeof APPROVAL_REQUEST_KINDS)[number][];

  /** What the refusal said, so the approver reads the same facts the receiver saw. */
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  detail!: string;

  @ValidateNested()
  @Type(() => ReceiveGoodsDto)
  delivery!: ReceiveGoodsDto;
}

export class AcceptHeldDeliveryDto {
  /** The delivery as the approver corrected it. Omitted, it is accepted as the receiver typed it. */
  @IsOptional()
  @ValidateNested()
  @Type(() => ReceiveGoodsDto)
  delivery?: ReceiveGoodsDto;

  /** Also move the supplier's agreed price to what was billed. */
  @IsOptional()
  @IsBoolean()
  updateSupplierPrice?: boolean;
}

export class RejectHeldDeliveryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  reason!: string;
}
