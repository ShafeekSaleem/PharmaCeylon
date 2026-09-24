import { Type } from "class-transformer";
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from "class-validator";
import { SupplierStatus, SupplierType } from "@prisma/client";

export class UpdateSupplierDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  name?: string;

  @IsOptional()
  @IsEnum(SupplierType)
  type?: SupplierType;

  @IsOptional()
  @IsEnum(SupplierStatus)
  status?: SupplierStatus;

  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== "")
  @IsString()
  @MaxLength(64)
  phone?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== "")
  @IsEmail()
  @MaxLength(256)
  email?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== "")
  @IsString()
  @MaxLength(128)
  contactName?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  leadTimeDays?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  paymentTermsDays?: number;

  /** Legacy; prefer `status`. When set, maps active↔inactive. */
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isActive?: boolean;

  // What an invoice needs to show and a payment needs to reach them.
  @IsOptional()
  @IsString()
  @MaxLength(256)
  addressLine?: string | null;
  @IsOptional()
  @IsString()
  @MaxLength(128)
  city?: string | null;
  @IsOptional()
  @IsString()
  @MaxLength(64)
  taxRegistrationNo?: string | null;
  @IsOptional()
  @IsString()
  @MaxLength(128)
  bankName?: string | null;
  @IsOptional()
  @IsString()
  @MaxLength(128)
  bankAccountName?: string | null;
  @IsOptional()
  @IsString()
  @MaxLength(64)
  bankAccountNo?: string | null;
}
