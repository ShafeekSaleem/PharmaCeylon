import { IsNotEmpty, IsString } from "class-validator";

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  currentPassword!: string;

  /** Checked against the tenant's password policy (TenantSettings) in the service, not here —
   *  the minimum length is tenant-configurable, not a fixed decorator constant. */
  @IsString()
  @IsNotEmpty()
  newPassword!: string;
}
