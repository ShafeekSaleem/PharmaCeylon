import { IsOptional, IsString, MaxLength } from "class-validator";

export class VoidSaleDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
