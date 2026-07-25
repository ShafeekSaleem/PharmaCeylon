import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from "class-validator";

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

export class CheckoutDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CheckoutLineDto)
  items!: CheckoutLineDto[];
}
