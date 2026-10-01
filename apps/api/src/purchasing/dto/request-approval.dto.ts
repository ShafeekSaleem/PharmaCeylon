import { IsIn, IsString, MaxLength, MinLength } from "class-validator";

export const APPROVAL_REQUEST_KINDS = ["over_delivery", "price_variance"] as const;

/** A receiver asking an approver to accept what they themselves may not. */
export class RequestApprovalDto {
  @IsIn(APPROVAL_REQUEST_KINDS)
  kind!: (typeof APPROVAL_REQUEST_KINDS)[number];

  /** What the refusal said, so the approver reads the same facts the receiver saw. */
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  detail!: string;
}
