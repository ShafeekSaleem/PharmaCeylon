import { IsString, IsUUID, MaxLength, MinLength } from "class-validator";

/**
 * The approver co-sign (P2b #103): someone else approves on this session, on the same counter,
 * with their own till PIN. Sent as `discountApproval` on checkout and as `coSign` on a refund
 * request's approve. Online only. The PIN is checked and dropped: never logged, audited or kept.
 */
export class ApproverCoSignDto {
  /** The approver chosen from `GET /sales/pos/discount-approvers` or `/sales/pos/refund-approvers`. */
  @IsUUID()
  approverUserId!: string;

  /** Their till PIN, or their login password when they have not set one. */
  @IsString()
  @MinLength(4)
  @MaxLength(128)
  pin!: string;
}
