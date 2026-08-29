import { IsEmail, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

/** Tenant code and timezone are intentionally absent — non-editable. */
export class UpdateTenantProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  legalName?: string;

  @IsOptional()
  @IsString()
  complianceRegion?: string;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  dateFormat?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  fiscalYearStartMonth?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  businessRegistrationNo?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  logoUrl?: string | null;

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
  @MaxLength(80)
  city?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  postalCode?: string | null;

  @IsOptional()
  @IsEmail()
  @MaxLength(160)
  email?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  taxIdentificationNo?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  vatRegistrationNo?: string | null;
}
