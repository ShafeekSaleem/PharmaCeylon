import { IsInt, IsOptional, IsUUID, Matches, Min, ValidateIf } from "class-validator";

/** The exact content the approver saw: `approvalReview` from GET /transfers/:id. */
export class ApproveTransferDto {
  @IsUUID()
  approvalId!: string;

  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @Matches(/^[0-9a-f]{64}$/)
  expectedDigest!: string;
}

/** Pins the displayed approval (`executionApprovalId`); null only where approval is waived. */
export class DispatchTransferDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  approvalId?: string | null;
}
