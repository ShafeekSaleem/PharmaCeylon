import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { RoleName } from "@prisma/client";

export class StaffInvitationAssignmentDto {
  @IsUUID()
  branchId!: string;

  @IsEnum(RoleName)
  role!: RoleName;

  @IsOptional()
  @IsUUID()
  roleId?: string;
}

export class CreateStaffInvitationDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MaxLength(256)
  fullName!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => StaffInvitationAssignmentDto)
  assignments!: StaffInvitationAssignmentDto[];
}
