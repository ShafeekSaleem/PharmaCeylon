import { PaymentMethod } from "@prisma/client";
import { SALE_CHANNELS, type SaleChannel } from "@pharmaceylon/shared";
import { Type } from "class-transformer";
import {
  IsEnum,
  IsIn,
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
const MONEY = /^\d{1,10}(\.\d{1,2})?$/;

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

  /** Part of an invoice number; spaces are ignored. With `registerId` or `terminalId`, scoped to that counter. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  invoiceNo?: string;

  /**
   * The customer's phone, or part of it. Only the digits count, on both sides, so
   * "071 482 0937", "0714820937" and "+94 71 482 0937" find the same customer.
   */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/(?:\D*\d){4}/, { message: "customerPhone needs at least 4 digits" })
  customerPhone?: string;

  /** Lowest sale total, inclusive. */
  @IsOptional()
  @Matches(MONEY, { message: "minTotal must be an amount like 1250.00" })
  minTotal?: string;

  /** Highest sale total, inclusive. */
  @IsOptional()
  @Matches(MONEY, { message: "maxTotal must be an amount like 1250.00" })
  maxTotal?: string;

  /** Enrolled counter terminal (`OperationalTerminal`). */
  @IsOptional()
  @IsUUID()
  terminalId?: string;

  /** Register / till counter id (`TerminalCounter`). */
  @IsOptional()
  @IsUUID()
  registerId?: string;

  /** Till drawer id, when filtering by till rather than register. */
  @IsOptional()
  @IsUUID()
  tillId?: string;

  /** Till shift the sale was rung up on. */
  @IsOptional()
  @IsUUID()
  shiftId?: string;

  /** Checkout channel: `web_legacy`, `desktop_online`, `offline`, or `fallback`. */
  @IsOptional()
  @IsIn(SALE_CHANNELS as unknown as SaleChannel[])
  channel?: SaleChannel;
}