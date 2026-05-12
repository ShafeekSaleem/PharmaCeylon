import { IsOptional, IsString, MaxLength } from "class-validator";

export class RefundSaleDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
