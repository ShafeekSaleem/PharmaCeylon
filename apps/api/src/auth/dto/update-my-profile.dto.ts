import { IsNotEmpty, IsOptional, IsString, MaxLength, Matches } from "class-validator";

/** Email is intentionally absent — it's globally unique and resolves tenant on login, so
 *  self-service email change needs a verification flow that's out of scope here. */
export class UpdateMyProfileDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  fullName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^\+?[0-9 ()-]*$/, { message: "phone must be a valid phone number" })
  phone?: string | null;
}
