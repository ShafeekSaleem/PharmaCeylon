import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

export class CashCountLineDto {
  @IsInt()
  @Min(1)
  denominationMinor!: number;

  @IsInt()
  @Min(0)
  @Max(100_000)
  count!: number;
}

/** A drawer count: the total the counter added up and the note-and-coin lines behind it. */
export class CashCountDto {
  @IsInt()
  @Min(0)
  @Max(2_000_000_000)
  totalMinor!: number;

  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CashCountLineDto)
  lines!: CashCountLineDto[];
}

/** POST /terminals/sessions/:workSessionId/shifts — D7b `shift_open`, online. */
export class OpenTillShiftDto {
  /** The new shift's work-session ID, generated on the counter so a resend opens it once. */
  @IsUUID()
  shiftId!: string;

  @Matches(/^\d{4,8}$/, { message: "A PIN is 4 to 8 digits." })
  pin!: string;

  @ValidateNested()
  @Type(() => CashCountDto)
  openingCount!: CashCountDto;

  /** The closed shift the counter last saw on this till; refused if the till has moved on. */
  @IsOptional()
  @IsUUID()
  previousClosedWorkSessionId?: string | null;
}

export class ShiftAssistanceDto {
  /** The closing manager's own PIN. */
  @Matches(/^\d{4,8}$/, { message: "A PIN is 4 to 8 digits." })
  pin!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

/** POST /terminals/sessions/:workSessionId/shifts/:shiftId/close — D7b `shift_close`, online. */
export class CloseTillShiftDto {
  /** The counter's command ID for this close; a resend with it replays the recorded close. */
  @IsUUID()
  commandId!: string;

  @ValidateNested()
  @Type(() => CashCountDto)
  closingCount!: CashCountDto;

  /** The counter's own running expected cash, kept beside the server's figure. */
  @IsOptional()
  @IsInt()
  @Min(-2_000_000_000)
  @Max(2_000_000_000)
  counterExpectedCashMinor?: number | null;

  /** Present only for a manager closing someone else's shift. */
  @IsOptional()
  @ValidateNested()
  @Type(() => ShiftAssistanceDto)
  assistance?: ShiftAssistanceDto | null;
}
