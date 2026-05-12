import { IsEnum, IsUUID } from "class-validator";
import { RoleName } from "@prisma/client";

export class AssignBranchRoleDto {
  @IsUUID()
  branchId!: string;

  @IsEnum(RoleName)
  role!: RoleName;
}
