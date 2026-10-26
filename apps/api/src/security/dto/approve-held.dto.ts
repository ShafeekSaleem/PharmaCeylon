import { IsInt, IsUUID, Matches, Min } from "class-validator";

/** Stable retry identity and the exact server preview the reviewer inspected. */
export class ApproveHeldDto {
  @IsUUID()
  approvalId!: string;

  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @Matches(/^[0-9a-f]{64}$/)
  expectedDigest!: string;
}

export class PostHeldDto {
  @IsUUID()
  approvalId!: string;
}
