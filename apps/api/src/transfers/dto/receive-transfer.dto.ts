import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsUUID,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";

export class ReceiveTransferLineDto {
  @IsUUID()
  transferItemId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;
}

/** Omit `lines` (or pass empty) to receive all remaining qty on every line. */
export class ReceiveTransferDto {
  /** Optional pin: the dispatch (its approval, null if waived) the counter is receiving. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  dispatchApprovalId?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReceiveTransferLineDto)
  lines?: ReceiveTransferLineDto[];
}
