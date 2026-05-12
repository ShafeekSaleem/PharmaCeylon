import { IsEmail, IsString, MaxLength, MinLength } from "class-validator";

export class CreateTenantUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @IsString()
  @MaxLength(256)
  fullName!: string;
}
