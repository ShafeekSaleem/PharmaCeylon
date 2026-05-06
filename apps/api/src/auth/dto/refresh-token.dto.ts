import { IsString, MinLength } from "class-validator";

export class RefreshTokenDto {
  @IsString()
  @MinLength(16)
  refreshToken!: string;
}
