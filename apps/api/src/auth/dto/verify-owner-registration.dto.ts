import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";

export class VerifyOwnerRegistrationDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(256)
  @Matches(/^(?:\d{6}|[A-Za-z0-9_-]{32,256})$/, {
    message: "code must be the 6-digit verification code",
  })
  code!: string;
}
