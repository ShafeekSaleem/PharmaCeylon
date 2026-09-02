import { Transform } from "class-transformer";
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";

export class CreateOwnerRegistrationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  firstName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  lastName!: string;

  @IsEmail()
  @MaxLength(254)
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^\+?[0-9 ()-]{7,32}$/, {
    message: "phone must be a valid phone number",
  })
  phone?: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  @Matches(/^(?=.*\d)(?=.*[^A-Za-z0-9]).+$/, {
    message: "password must contain a number and a symbol",
  })
  password!: string;
}
