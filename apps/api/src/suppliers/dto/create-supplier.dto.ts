import { Type } from "class-transformer";
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from "class-validator";
import { SupplierStatus, SupplierType } from "@prisma/client";

export class CreateSupplierDto {
  @IsString()
  @MaxLength(64)
  code!: string;

  @IsString()
  @MaxLength(256)
  name!: string;

  @IsOptional()
  @IsEnum(SupplierType)
  type?: SupplierType;

  @IsOptional()
  @IsEnum(SupplierStatus)
  status?: SupplierStatus;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  phone?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(256)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  contactName?: string;

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
}
