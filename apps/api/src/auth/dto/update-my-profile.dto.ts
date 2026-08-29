import { IsOptional, IsString } from "class-validator";

/** Email is intentionally absent — it's globally unique and resolves tenant on login, so
 *  self-service email change needs a verification flow that's out of scope here. */
export class UpdateMyProfileDto {
  @IsOptional()
  @IsString()
  fullName?: string;

  @IsOptional()
  @IsString()
  phone?: string | null;
}
