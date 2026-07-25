import { Type } from "class-transformer";
import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from "class-validator";

export class CreateSupplierInvoiceDto {
  @IsString()
  @MaxLength(64)
  invoiceNumber!: string;

  @IsDateString()
  invoiceDate!: string;

  @IsDateString()
  dueDate!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  totalAmount!: number;

  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  notes?: string;
}
