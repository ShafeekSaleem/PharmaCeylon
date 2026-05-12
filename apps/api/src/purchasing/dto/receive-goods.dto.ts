import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from "class-validator";

export class ReceiveGoodsLineDto {
  @IsUUID()
  productId!: string;

  @IsString()
  batchNo!: string;

  @IsDateString()
  expiryDate!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  receivedQty!: number;

  /** Decimal string */
  @IsString()
  costPrice!: string;

  /** Decimal string */
  @IsString()
  sellingPrice!: string;
}

export class ReceiveGoodsDto {
  @IsUUID()
  purchaseOrderId!: string;

  @IsDateString()
  receivedOn!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReceiveGoodsLineDto)
  lines!: ReceiveGoodsLineDto[];
}
