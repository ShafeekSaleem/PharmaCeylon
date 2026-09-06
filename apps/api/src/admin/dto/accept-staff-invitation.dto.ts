import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class AcceptStaffInvitationDto {
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  fullName?: string;
}
