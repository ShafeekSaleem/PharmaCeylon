import {
  SUPPORT_MANAGER_HELD_REASONS,
  type SupportManagerHeldReason,
} from "../../terminals/support-queue-predicates";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from "class-validator";

export class SalesQueuePageDto {
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
}

export class ListIncidentNotesQueryDto extends SalesQueuePageDto {
  @IsOptional()
  @IsIn(["open", "held"])
  status?: "open" | "held";

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsIn(["receivedAt", "recordedAt"])
  sort?: "receivedAt" | "recordedAt";
}

export class ListPaymentRecoveryQueryDto extends SalesQueuePageDto {
  @IsOptional()
  @IsIn([...SUPPORT_MANAGER_HELD_REASONS])
  heldReason?: SupportManagerHeldReason;

  @IsOptional()
  @IsIn(["receivedAt", "recordedAt"])
  sort?: "receivedAt" | "recordedAt";
}

export class ListCollectedMoneyQueryDto extends SalesQueuePageDto {
  @IsOptional()
  @IsUUID()
  shiftId?: string;
}