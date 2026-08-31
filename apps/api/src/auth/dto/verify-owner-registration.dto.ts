import { IsString, MaxLength, MinLength } from "class-validator";

export class VerifyOwnerRegistrationDto {
  @IsString()
  @MinLength(32)
  @MaxLength(256)
  token!: string;
}
