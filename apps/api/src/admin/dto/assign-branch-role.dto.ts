import { IsEnum, IsOptional, IsUUID } from "class-validator";
import { RoleName } from "@prisma/client";

export class AssignBranchRoleDto {
  @IsUUID()
  branchId!: string;

  @IsEnum(RoleName)
  role!: RoleName;

  /** Required when `role` is `custom` — the tenant's custom Role id to grant. */
  @IsOptional()
  @IsUUID()
  roleId?: string;
}
