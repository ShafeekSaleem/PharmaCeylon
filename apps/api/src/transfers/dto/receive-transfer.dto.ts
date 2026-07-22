import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsUUID,
  Min,
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
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReceiveTransferLineDto)
  lines?: ReceiveTransferLineDto[];
}
