import { IsIn } from "class-validator";

export class ConfirmReadinessTaskDto {
  @IsIn(["sales_settings", "checkout"])
  task!: "sales_settings" | "checkout";
}
