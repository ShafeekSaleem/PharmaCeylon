import { IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min } from "class-validator";
import { OFFLINE_STOCK_RESOLUTION_KINDS, type OfflineStockResolutionKind } from "@pharmaceylon/shared";

export class ListStockCasesQueryDto {
  @IsOptional()
  @IsIn(["open", "resolved"])
  status?: "open" | "resolved";
}

/**
 * A resolution plan for one case. `links` (link_existing_settlement only) names, per case batch,
 * a posted stocktake (`{ batchId, source: "stocktake", stocktakeId }`) or write-off/correction
 * movements (`{ batchId, source: "movements", ledgerEntryIds }`); the service checks each.
 */
export class PrepareStockResolutionDto {
  @IsIn(OFFLINE_STOCK_RESOLUTION_KINDS)
  kind!: OfflineStockResolutionKind;

  @IsOptional()
  @IsArray()
  links?: unknown[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ApproveStockResolutionDto {
  @IsUUID()
  approvalId!: string;

  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @Matches(/^[0-9a-f]{64}$/)
  expectedDigest!: string;
}
