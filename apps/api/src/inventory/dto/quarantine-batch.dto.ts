import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from "class-validator";
import {
  QUARANTINE_REASON_CODES,
  type QuarantineReasonCode,
} from "../stock/stock-reasons";

export class QuarantineBatchDto {
  /** Units to hold. Omit to hold everything available on the batch. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty?: number;

  @IsIn(QUARANTINE_REASON_CODES)
  reasonCode!: QuarantineReasonCode;

  /** What was seen. Required when the code is `other`, optional otherwise. */
  @ValidateIf((o: QuarantineBatchDto) => o.reasonCode === "other" || o.reason !== undefined)
  @IsString()
  @MaxLength(512)
  reason?: string;
}

export class ReleaseQuarantineDto {
  /** Units to release. Omit to release everything held on the batch. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty?: number;

  /** What the inspection found. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  reason?: string;
}
