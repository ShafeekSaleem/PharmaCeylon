import { IsIn } from "class-validator";

export class ConfirmReadinessTaskDto {
  @IsIn(["sales_settings", "opening_inventory", "checkout"])
  task!: "sales_settings" | "opening_inventory" | "checkout";
}
