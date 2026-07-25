import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { ReturnLineDto } from "./create-return.dto";

export class UpdateReturnDto {
  @IsOptional()
  @IsIn(["customer", "supplier"])
  type?: "customer" | "supplier";

  @IsOptional()
  @IsString()
  @MaxLength(255)
  customerName?: string | null;

  @IsOptional()
  @IsUUID()
  saleId?: string | null;

  @IsOptional()
  @IsUUID()
  supplierId?: string | null;

  @IsOptional()
  @IsUUID()
  purchaseOrderId?: string | null;

  @IsOptional()
  @IsUUID()
  goodsReceiptId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @IsOptional()
  @IsBoolean()
  submit?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReturnLineDto)
  items?: ReturnLineDto[];
}
