import { IsEmail, IsString, MaxLength, MinLength } from "class-validator";

export class RequestPasswordResetDto {
  @IsEmail()
  @MaxLength(256)
  email!: string;
}

export class ConfirmPasswordResetDto {
  @IsString()
  @MaxLength(512)
  token!: string;

  /** Floor only — the tenant's configured `passwordMinLength` is applied on top. */
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword!: string;
}
