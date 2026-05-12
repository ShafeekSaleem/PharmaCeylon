import { Type } from "class-transformer";
import { IsInt, IsUUID, Min } from "class-validator";

export class SupplierReturnDto {
  @IsUUID()
  productId!: string;

  @IsUUID()
  batchId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;
}
