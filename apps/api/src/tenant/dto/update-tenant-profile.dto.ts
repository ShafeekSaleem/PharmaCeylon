import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";

/** Tenant code and timezone are intentionally absent — non-editable. */
export class UpdateTenantProfileDto {
  @IsOptional()
  @IsString()
  displayName?: string;

  @IsOptional()
  @IsString()
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
  businessRegistrationNo?: string | null;
}
