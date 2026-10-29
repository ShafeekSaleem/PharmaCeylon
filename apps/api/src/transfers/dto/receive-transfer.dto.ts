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

  /**
   * The line's `receivedQty` the screen showed. When sent, a receipt counted against an older
   * figure is refused (409), so two partial receives of the same arrival can't both post.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  receivedQtyBefore?: number;
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
