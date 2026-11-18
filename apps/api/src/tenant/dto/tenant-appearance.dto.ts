import { IsInt, IsObject, Min } from "class-validator";

/** Replace the pharmacy brand, naming the version the owner's form loaded (0 = never saved). */
export class UpdateTenantAppearanceDto {
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  /** Checked by validatePharmacyAppearance from @pharmaceylon/shared, the same rule the form uses. */
  @IsObject()
  appearance!: Record<string, unknown>;
}
