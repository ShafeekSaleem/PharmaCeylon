import { IsEmail, IsString, Matches, MaxLength, MinLength } from "class-validator";

export class LoginDto {
  /** Tenant short code (e.g. from seed: `demo`). Case-insensitive. */
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(/^[-a-zA-Z0-9_]+$/, {
    message: "tenantCode must contain only letters, digits, underscore, or hyphen",
  })
  tenantCode!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}
