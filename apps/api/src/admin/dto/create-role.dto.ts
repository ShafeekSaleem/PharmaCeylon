import {
  IsBoolean,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

export class CreateRoleDto {
  @IsOptional()
  @IsBoolean()
  backOfficeAccess?: boolean;

  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissionKeys!: string[];
}
