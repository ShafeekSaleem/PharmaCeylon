import { IsBoolean, IsDateString, IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength, Matches } from "class-validator";

export class UpdateBranchDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(24)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: "code may contain only letters, numbers, hyphens and underscores" })
  code?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(180)
  addressLine1?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(180)
  addressLine2?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string | null;

  @IsOptional()
  @IsEmail()
  @MaxLength(160)
  email?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  district?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  postalCode?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  pharmacyLicenceNo?: string | null;

  @IsOptional()
  @IsDateString()
  pharmacyLicenceExpiry?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  responsiblePharmacist?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  pharmacistSlmcNo?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  openingHours?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
