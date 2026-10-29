import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { ReceiveGoodsLineDto } from "./receive-goods.dto";

/**
 * A delivery prepared away from the counter: the receiving form without the order (it is in the
 * route) and without a received date — the goods are received on the day the counter posts them.
 * The exception choices are part of what the approver approves.
 */
export class PreparedDeliveryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  supplierDeliveryNote?: string;

  @IsOptional()
  @IsBoolean()
  acceptOverDelivery?: boolean;

  @IsOptional()
  @IsBoolean()
  acceptPriceVariance?: boolean;

  @IsOptional()
  @IsBoolean()
  updateSupplierPrice?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReceiveGoodsLineDto)
  lines!: ReceiveGoodsLineDto[];
}

export class CreatePreparedReceiptDto {
  @ValidateNested()
  @Type(() => PreparedDeliveryDto)
  delivery!: PreparedDeliveryDto;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

/** Saving a change needs the revision on screen; a material change clears any approval. */
export class UpdatePreparedReceiptDto {
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => PreparedDeliveryDto)
  delivery?: PreparedDeliveryDto;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

export class CancelPreparedReceiptDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
