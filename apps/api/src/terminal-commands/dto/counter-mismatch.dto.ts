import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import {
  COUNTER_MISMATCH_KINDS,
  COUNTER_MISMATCH_PROBLEMS,
  type CounterMismatchKind,
  type CounterMismatchProblem,
} from "@pharmaceylon/shared";

/** Exactly one of `index` (a delivery line) or `transferItemId` (a transfer line). */
export class CounterMismatchLineDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  index?: number;

  @IsOptional()
  @IsUUID()
  transferItemId?: string;
}

/** `POST /counter-work/mismatches` (decision 1). See `ReportCounterMismatchBody`. */
export class ReportCounterMismatchDto {
  @IsIn(COUNTER_MISMATCH_KINDS)
  kind!: CounterMismatchKind;

  @IsUUID()
  documentId!: string;

  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  approvalId!: string | null;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  documentVersion!: number;

  @ValidateIf((_, value) => value !== null)
  @ValidateNested()
  @Type(() => CounterMismatchLineDto)
  line!: CounterMismatchLineDto | null;

  @IsIn(COUNTER_MISMATCH_PROBLEMS)
  problem!: CounterMismatchProblem;

  @ValidateIf((_, value) => value !== null && value !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  countedQty!: number | null;

  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  @MaxLength(500)
  note!: string | null;
}

/** `POST /counter-work/mismatches/:id/dismiss` on the web: keep the document as approved. */
export class DismissCounterMismatchDto {
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  @MaxLength(500)
  note!: string | null;
}

export class CounterMismatchQueryDto {
  @IsIn(COUNTER_MISMATCH_KINDS)
  kind!: CounterMismatchKind;

  @IsUUID()
  documentId!: string;
}
