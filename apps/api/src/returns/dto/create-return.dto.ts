import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

export class ReturnLineDto {
  @IsUUID()
  productId!: string;

  @IsUUID()
  batchId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unitPrice?: number;
}

export class CreateReturnDto {
  @IsIn(["customer", "supplier"])
  type!: "customer" | "supplier";

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

  /** When true, move past draft (pending_approval or awaiting_logistics for managers). */
  @IsOptional()
  @IsBoolean()
  submit?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReturnLineDto)
  items!: ReturnLineDto[];
}
