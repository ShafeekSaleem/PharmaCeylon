import { IsBoolean, IsOptional } from "class-validator";

export class UpdateNotificationPreferencesDto {
  @IsOptional()
  @IsBoolean()
  inventoryEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  expiryEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  purchasingEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  transfersEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  stocktakesEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  salesEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  complianceEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  systemEnabled?: boolean;
}
