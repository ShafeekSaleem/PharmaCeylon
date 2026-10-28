import { IsInt, IsObject, Min } from "class-validator";

/** Replace the tenant's counter alert rules using the version the editor actually loaded. */
export class UpdateCounterAlertsDto {
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsObject()
  policy!: Record<string, unknown>;
}
