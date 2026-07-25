import { Type } from "class-transformer";
import { IsNumber, IsOptional, IsString, MaxLength, Min } from "class-validator";

export class RecordSupplierPaymentDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  notes?: string;
}
