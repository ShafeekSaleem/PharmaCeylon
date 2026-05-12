import { Type } from "class-transformer";
import { IsInt, IsUUID, Min } from "class-validator";

export class CustomerReturnDto {
  @IsUUID()
  productId!: string;

  @IsUUID()
  batchId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;

  @IsUUID()
  /** Logical link to original sale (for audit); stock is still validated on batch. */
  saleId!: string;
}
