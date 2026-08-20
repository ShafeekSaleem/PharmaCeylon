import { ArrayUnique, IsArray, IsString } from "class-validator";

export class UpdateRolePermissionsDto {
  /** Full replacement set — every permission key the role should hold after this call. */
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissionKeys!: string[];
}
