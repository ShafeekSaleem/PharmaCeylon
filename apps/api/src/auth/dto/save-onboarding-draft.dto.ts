import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { ONBOARDING_DEPARTMENT_GROUPS } from "../../catalog/commercial-category-template";
import { SUPPORTED_CURRENCIES } from "../../common/currency.constants";

/** Valid values for `sellsDepartments` — the labels the wizard shows. */
const ONBOARDING_DEPARTMENT_LABELS = ONBOARDING_DEPARTMENT_GROUPS.map((g) => g.label);

export class SaveOnboardingDraftDto {
  @IsInt() @Min(1) @Max(4) currentStep!: number;

  @IsOptional() @IsString() @MaxLength(120) businessName?: string;
  @IsOptional() @IsString() @MaxLength(160) legalName?: string;
  @IsOptional() @IsString() @MaxLength(2) country?: string;
  /** LKR-only until a currency formatter exists — see currency.constants.ts. */
  @IsOptional() @IsIn(SUPPORTED_CURRENCIES) currency?: string;
  @IsOptional() @IsString() @MaxLength(64) timezone?: string;
  @IsOptional() @IsEmail() @MaxLength(160) businessEmail?: string;
  @IsOptional() @IsString() @MaxLength(6) businessPhoneCountryCode?: string;
  @IsOptional() @IsString() @MaxLength(32) businessPhone?: string;
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/^\/uploads\/onboarding-logos\/[0-9a-f-]+\.webp$/i)
  businessLogoUrl?: string | null;

  @IsOptional() @IsString() @MaxLength(120) branchName?: string;
  @IsOptional() @IsString() @MaxLength(24) branchCode?: string;
  @IsOptional() @IsString() @MaxLength(180) addressLine1?: string;
  @IsOptional() @IsString() @MaxLength(80) city?: string;
  @IsOptional() @IsString() @MaxLength(16) postalCode?: string;
  @IsOptional() @IsString() @MaxLength(80) province?: string;
  @IsOptional() @IsString() @MaxLength(80) district?: string;
  @IsOptional() @IsString() @MaxLength(2) branchCountry?: string;
  @IsOptional() @IsString() @MaxLength(64) branchTimezone?: string;
  @IsOptional() @IsString() @MaxLength(6) branchPhoneCountryCode?: string;
  @IsOptional() @IsString() @MaxLength(32) branchPhone?: string;
  @IsOptional() @IsBoolean() useBusinessPhone?: boolean;

  @IsOptional() @IsIn(["fresh", "migrating"]) migrationMode?:
    | "fresh"
    | "migrating";
  /**
   * "What does your pharmacy sell" — labels from ONBOARDING_DEPARTMENT_GROUPS. Applied at
   * provisioning so a shop selling shampoo and baby food has those departments switched on
   * from the first minute, instead of having to find Settings → Catalog → Categories before
   * it can file anything under them.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(16)
  @IsIn(ONBOARDING_DEPARTMENT_LABELS, { each: true })
  sellsDepartments?: string[];
  @IsOptional() @IsString() @MaxLength(120) receiptDisplayName?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsIn(["cash", "card", "mobile_wallet", "credit"], { each: true })
  paymentMethods?: string[];
  @IsOptional() @IsString() @MaxLength(24) dateFormat?: string;
}
