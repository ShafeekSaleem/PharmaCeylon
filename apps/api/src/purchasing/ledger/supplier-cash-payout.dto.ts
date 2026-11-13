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
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { SupplierCashPayoutStatus } from "@prisma/client";
import { AllocationDto } from "./supplier-ledger.dto";

/** Remote preparation of cash owed to a supplier (revised D10). No ledger payment or drawer cash yet. */
export class PrepareSupplierCashPayoutDto {
  @IsUUID()
  supplierId!: string;

  @IsDateString()
  paidOn!: string;

  @IsString()
  amount!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AllocationDto)
  allocations?: AllocationDto[];

  /** Optional PO for display on the counter (e.g. cash on delivery). */
  @IsOptional()
  @IsUUID()
  purchaseOrderId?: string;
}

export class ApproveSupplierCashPayoutDto {
  @IsUUID()
  approvalId!: string;

  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @Matches(/^[0-9a-f]{64}$/)
  expectedDigest!: string;
}

export class ExecuteSupplierCashPayoutDto {
  @IsOptional()
  @IsUUID()
  approvalId?: string;
}

export class ListSupplierCashPayoutsQueryDto {
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @IsOptional()
  @IsEnum(SupplierCashPayoutStatus)
  status?: SupplierCashPayoutStatus;

  /** When true, only payouts waiting at the counter (approved, approval intact). */
  @IsOptional()
  readyAtCounter?: string;
}
