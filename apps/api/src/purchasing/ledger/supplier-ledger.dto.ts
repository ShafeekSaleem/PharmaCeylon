import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { SupplierPaymentMethod } from "@prisma/client";

export class SupplierInvoiceLineDto {
  /** Omit for a line the supplier billed that is not one of our products (freight, a fee). */
  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;

  /** Decimal string, as printed on the invoice. */
  @IsString()
  unitCost!: string;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  @Max(100)
  discountPercent?: number;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  @Max(100)
  taxPercent?: number;
}

export class CreateSupplierInvoiceRecordDto {
  @IsUUID()
  supplierId!: string;

  /** The supplier's own invoice number, as printed. */
  @IsString()
  @MaxLength(64)
  invoiceNumber!: string;

  @IsDateString()
  invoiceDate!: string;

  /** Defaults to the invoice date plus the supplier's payment terms. */
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  /** Deliveries this invoice bills for. One invoice may cover several. */
  @IsOptional()
  @IsArray()
  @IsUUID("all", { each: true })
  receiptIds?: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SupplierInvoiceLineDto)
  lines!: SupplierInvoiceLineDto[];

  /** Decimal string. The tax printed on the invoice; worked out from line rates if omitted. */
  @IsOptional()
  @IsString()
  taxAmount?: string;

  @IsOptional()
  @IsString()
  shippingAmount?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class VoidDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class AllocationDto {
  @IsUUID()
  invoiceId!: string;

  /** Decimal string. */
  @IsString()
  amount!: string;
}

export class RecordSupplierPaymentLedgerDto {
  @IsUUID()
  supplierId!: string;

  @IsDateString()
  paidOn!: string;

  /** Decimal string. */
  @IsString()
  amount!: string;

  @IsEnum(SupplierPaymentMethod)
  method!: SupplierPaymentMethod;

  /** Cheque number, bank transfer reference, receipt number. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  /**
   * Which invoices this settles. Omit to settle the oldest due first — which is what "pay the
   * supplier 50,000" usually means.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AllocationDto)
  allocations?: AllocationDto[];
}

export class ApplyDebitNoteDto {
  /** Omit to apply against the oldest open invoices first. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AllocationDto)
  allocations?: AllocationDto[];
}
