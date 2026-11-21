import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { TRANSFER_SHORT_CLOSE_REASONS, type TransferShortCloseReason } from "@pharmaceylon/shared";

export class CloseShortLineDto {
  @IsUUID()
  transferItemId!: string;

  /** What the manager saw still on the way on this line. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;
}

/** `POST /transfers/:id/close-short` (P6 #52 decision 2). See `CloseShortTransferBody`. */
export class CloseShortTransferDto {
  @IsIn(TRANSFER_SHORT_CLOSE_REASONS)
  reason!: TransferShortCloseReason;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  note!: string;

  /** Every line still on the way, as the manager saw it; anything received since is refused. */
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CloseShortLineDto)
  remaining!: CloseShortLineDto[];
}
