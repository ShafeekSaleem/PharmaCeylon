import { Type } from "class-transformer";
import { IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateNested } from "class-validator";

/** Embedded on checkout when a cashier needs pharmacist co-sign. */
export class PharmacistApprovalDto {
  @IsUUID()
  approverUserId!: string;

  /**
   * Till PIN (4–8 digits) when the approver has set one, otherwise their login password.
   * Never logged.
   */
  @IsString()
  @MinLength(4)
  @MaxLength(128)
  pin!: string;
}

export class SetPosPinDto {
  /** 4–8 digit numeric PIN for counter co-sign. */
  @IsString()
  @Matches(/^\d{4,8}$/, { message: "POS PIN must be 4–8 digits" })
  pin!: string;

  /** Current login password — required to set or rotate the till PIN. */
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}

export class ClearPosPinDto {
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}

export class CheckoutPharmacistApprovalWrapper {
  @IsOptional()
  @ValidateNested()
  @Type(() => PharmacistApprovalDto)
  pharmacistApproval?: PharmacistApprovalDto;
}
