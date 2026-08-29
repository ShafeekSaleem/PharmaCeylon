import { IsBoolean, IsOptional, IsString } from "class-validator";

export class UpdateBranchDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  city?: string | null;

  @IsOptional()
  @IsString()
  addressLine1?: string | null;

  @IsOptional()
  @IsString()
  phone?: string | null;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
