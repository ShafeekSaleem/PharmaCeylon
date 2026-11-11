import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from "class-validator";
import {
  SETTLEMENT_DECISIONS,
  type SettlementDecision,
} from "./journal-entry-settlement";

export class ListJournalReviewsQueryDto {
  @IsOptional()
  @IsIn(["open", "closed"])
  status?: "open" | "closed";
}

/** A decision on one refused entry. A reason is required for both: either is an exception. */
export class PrepareJournalSettlementDto {
  @IsIn(SETTLEMENT_DECISIONS)
  decision!: SettlementDecision;

  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class ApproveJournalSettlementDto {
  @IsUUID()
  approvalId!: string;

  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @Matches(/^[0-9a-f]{64}$/)
  expectedDigest!: string;
}
