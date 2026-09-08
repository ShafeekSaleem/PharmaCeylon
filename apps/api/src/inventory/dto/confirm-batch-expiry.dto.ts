import { IsString, Matches } from "class-validator";
export class ConfirmBatchExpiryDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  expiryDate!: string;
}
