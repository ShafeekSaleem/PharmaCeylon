import { IsDateString, IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength, Matches } from "class-validator";

export class CreateBranchDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(24)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: "code may contain only letters, numbers, hyphens and underscores" })
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(180)
  addressLine1?: string;

  @IsOptional()
  @IsString()
  @MaxLength(180)
  addressLine2?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(160)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  district?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  postalCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  pharmacyLicenceNo?: string;

  @IsOptional()
  @IsDateString()
  pharmacyLicenceExpiry?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  responsiblePharmacist?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  pharmacistSlmcNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  openingHours?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}
