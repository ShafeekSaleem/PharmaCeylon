import { IsNotEmpty, IsString, IsUUID, Matches, MaxLength } from "class-validator";

/** POST /admin/pharmacist-registrations */
export class RecordPharmacistRegistrationDto {
  @IsUUID()
  userId!: string;

  /** As printed on the SLMC certificate; stored trimmed and upper-case. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  slmcNumber!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "expiresOn must be YYYY-MM-DD" })
  expiresOn!: string;
}

/** POST /admin/pharmacist-registrations/:id/revoke */
export class RevokePharmacistRegistrationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
