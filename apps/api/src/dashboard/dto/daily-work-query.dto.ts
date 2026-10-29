import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, Max, Min } from "class-validator";
import type { WorkCategory, WorkFilter } from "@pharmaceylon/shared";

export class DailyWorkQueryDto {
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
