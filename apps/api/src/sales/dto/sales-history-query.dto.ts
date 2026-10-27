import { PaymentMethod } from "@prisma/client";
import { Type } from "class-transformer";
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from "class-validator";

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Query for `GET /sales/history` — the back-office Sales list. */
export class SalesHistoryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  /** A branch id, or `all` for every branch the caller can view. Omitted: the active branch. */
  @ValidateIf((query: SalesHistoryQueryDto) => query.branchId !== undefined && query.branchId !== "all")
  @IsUUID()
  branchId?: string;

  /** First tenant calendar day, `YYYY-MM-DD`, inclusive. */
  @IsOptional()
  @Matches(DATE_KEY, { message: "from must be a date (YYYY-MM-DD)" })
  from?: string;

  /** Last tenant calendar day, `YYYY-MM-DD`, inclusive. */
  @IsOptional()
  @Matches(DATE_KEY, { message: "to must be a date (YYYY-MM-DD)" })
  to?: string;

  /** The staff member who rang the sale up. */
  @IsOptional()
  @IsUUID()
  soldBy?: string;

  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  /** Part of an invoice number; spaces are ignored. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  invoiceNo?: string;
}
