import { IsInt, IsObject, Min } from "class-validator";

/** Replace one branch's document using the version the editor actually loaded. */
export class UpdateCounterPolicyDto {
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsObject()
  policy!: Record<string, unknown>;
}
