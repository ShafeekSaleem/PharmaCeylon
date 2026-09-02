import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

export class SaveOnboardingDraftDto {
  @IsInt() @Min(1) @Max(4) currentStep!: number;

  @IsOptional() @IsString() @MaxLength(120) businessName?: string;
  @IsOptional() @IsString() @MaxLength(160) legalName?: string;
  @IsOptional() @IsString() @MaxLength(2) country?: string;
  @IsOptional() @IsString() @MaxLength(3) currency?: string;
  @IsOptional() @IsString() @MaxLength(64) timezone?: string;
  @IsOptional() @IsEmail() @MaxLength(160) businessEmail?: string;
  @IsOptional() @IsString() @MaxLength(32) businessPhone?: string;

  @IsOptional() @IsString() @MaxLength(120) branchName?: string;
  @IsOptional() @IsString() @MaxLength(24) branchCode?: string;
  @IsOptional() @IsString() @MaxLength(180) addressLine1?: string;
  @IsOptional() @IsString() @MaxLength(80) city?: string;
  @IsOptional() @IsString() @MaxLength(80) district?: string;
  @IsOptional() @IsString() @MaxLength(32) branchPhone?: string;
  @IsOptional() @IsBoolean() useBusinessPhone?: boolean;

  @IsOptional() @IsIn(["fresh", "migrating"]) migrationMode?: "fresh" | "migrating";
  @IsOptional() @IsString() @MaxLength(120) receiptDisplayName?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(8) @IsIn(["cash", "card", "mobile_wallet", "credit"], { each: true }) paymentMethods?: string[];
  @IsOptional() @IsString() @MaxLength(24) dateFormat?: string;
}
