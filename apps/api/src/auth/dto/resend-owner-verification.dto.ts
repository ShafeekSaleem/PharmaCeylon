import { Transform } from "class-transformer";
import { IsEmail, MaxLength } from "class-validator";

export class ResendOwnerVerificationDto {
  @IsEmail()
  @MaxLength(254)
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  email!: string;
}
