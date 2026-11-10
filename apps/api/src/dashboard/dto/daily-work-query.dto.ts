import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Max, Min } from "class-validator";
import { DAILY_WORK_KINDS, type DailyWorkKind, type WorkCategory, type WorkFilter } from "@pharmaceylon/shared";

export class DailyWorkQueryDto {
  /** Module pending views narrow the same projection used by the dashboard. */
  @IsOptional()
  @IsIn(DAILY_WORK_KINDS)
  kind?: DailyWorkKind;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @IsOptional()
  @IsIn(["all", "mine", "approvals", "overdue", "counter"])
  filter: WorkFilter = "all";

  @IsOptional()
  @IsIn([
    "purchasing",
    "transfers",
    "returns",
    "stocktakes",
    "counter",
    "inventory",
  ])
  category?: WorkCategory;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  page = 1;
}
