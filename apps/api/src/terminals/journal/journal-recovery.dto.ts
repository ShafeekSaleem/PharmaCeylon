import {
  IsInt,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from "class-validator";

/** Approve exactly the recovery that was shown: its server head and its unmatched entries. */
export class ApproveJournalRecoveryDto {
  /** How the unmatched entries' stock and cash were settled, or why there was nothing to settle. */
  @IsString()
  @Matches(/\S/)
  @MaxLength(1000)
  reason!: string;

  @IsInt()
  @Min(0)
  expectedServerHeadSequence!: number;

  @IsInt()
  @Min(0)
  expectedUnmatched!: number;
}

/** Close an abandoned restore recovery: why it will not complete, and what was done about it. */
export class CloseJournalRecoveryDto {
  @IsString()
  @Matches(/\S/)
  @MaxLength(1000)
  reason!: string;
}

export class MissingJournalSignOffDto {
  @IsUUID()
  enrollmentId!: string;

  @IsInt()
  @Min(1)
  expectedNominationVersion!: number;

  @IsInt()
  @Min(0)
  expectedServerHeadSequence!: number;

  /** What was reviewed: the counter's state, and how any sales it never uploaded are accounted for. */
  @IsString()
  @Matches(/\S/)
  @MaxLength(1000)
  reason!: string;
}
