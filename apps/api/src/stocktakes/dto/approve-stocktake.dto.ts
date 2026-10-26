import { IsInt, IsUUID, Matches, Min } from "class-validator";

export class ApproveStocktakeDto {
  @IsUUID()
  approvalId!: string;

  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @Matches(/^[0-9a-f]{64}$/)
  expectedDigest!: string;
}
