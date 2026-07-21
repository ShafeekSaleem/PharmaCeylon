import { Type } from "class-transformer";
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { CreatePoPriority } from "./create-purchase-order.dto";

export class UpdatePurchaseOrderDto {
  @IsOptional()
  @IsDateString()
  expectedOn?: string | null;

  @IsOptional()
  @IsEnum(CreatePoPriority)
  priority?: CreatePoPriority;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  supplierReference?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  paymentTermsDays?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  deliveryInstructions?: string | null;
}
