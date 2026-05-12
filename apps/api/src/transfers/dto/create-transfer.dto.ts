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

export class TransferLineDto {
  @IsUUID()
  productId!: string;

  @IsOptional()
  @IsUUID()
  batchId?: string | null;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;
}

export class CreateTransferDto {
  @IsUUID()
  toBranchId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TransferLineDto)
  items!: TransferLineDto[];
}
