import { Type } from "class-transformer";
import { IsInt, IsNotEmpty, IsString, IsUUID, MaxLength, Min } from "class-validator";

/** POST /terminals/offline-assignment/delegations */
export class CreateOfflineDelegationDto {
  @IsUUID()
  managerUserId!: string;
}

/** POST /terminals/offline-assignment/authorizations — `OfflineAssignmentAuthorizeRequest`. */
export class AuthorizeOfflineAssignmentDto {
  /** Client-generated; resending the same request is a no-op. */
  @IsUUID()
  authorizationId!: string;

  @IsUUID()
  targetTerminalId!: string;

  @IsUUID()
  targetEnrollmentId!: string;

  /** The `nominationVersion` the screen showed; a changed branch nomination is refused. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedNominationVersion!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

/** POST …/delegations/:id/revoke and …/authorizations/:id/revoke */
export class RevokeOfflineAssignmentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

/** POST /terminals/offline-assignment/activate/challenge — `OfflineActivationPrepareRequest`. */
export class PrepareOfflineActivationDto {
  @IsUUID()
  workSessionId!: string;

  @IsUUID()
  authorizationId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedNominationVersion!: number;
}
