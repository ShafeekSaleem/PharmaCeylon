import { Type } from "class-transformer";
import { IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from "class-validator";

/** POST /terminals/counters */
export class CreateTerminalCounterDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  label!: string;
}

/** POST /terminals/enrollments/challenge — `TerminalEnrollmentChallengeRequest`. */
export class BeginTerminalEnrollmentDto {
  @IsUUID()
  registerId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  keyId!: string;

  /** Raw 32-byte Ed25519 public key, lowercase hex. */
  @Matches(/^[0-9a-f]{64}$/)
  publicKeyHex!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  label!: string;
}

/** POST /terminals/enrollments/:id/revoke and /terminals/devices/:id/retire */
export class TerminalReasonDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

/** POST /terminals/sessions/:id/pin — set or change the caller's own PIN at this counter. */
export class SetCounterPinDto {
  @Matches(/^\d{4,8}$/, { message: "A PIN is 4 to 8 digits." })
  pin!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  password!: string;
}

/** POST /terminals/sessions/:id/prepare — enter the PIN once here to prepare this counter. */
export class PrepareCounterPinDto {
  @Matches(/^\d{4,8}$/, { message: "A PIN is 4 to 8 digits." })
  pin!: string;
}

/** POST /terminals/sessions/:id/test-receipt */
export class ConfirmTestReceiptDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(260)
  printerName!: string;
}

/** POST /terminals/enrollment-codes */
export class IssueEnrollmentCodeDto {
  @IsUUID()
  registerId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(1440)
  expiresInMinutes?: number;
}

/** POST /terminals/enrollments/code-challenge — `TerminalEnrollmentCodeChallengeRequest`. */
export class RedeemEnrollmentCodeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  keyId!: string;

  @Matches(/^[0-9a-f]{64}$/)
  publicKeyHex!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  label!: string;
}
