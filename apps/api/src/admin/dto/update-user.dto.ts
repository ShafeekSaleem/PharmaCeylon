import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  fullName?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
