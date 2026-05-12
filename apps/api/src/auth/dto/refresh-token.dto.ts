import { IsOptional, IsString, MinLength } from "class-validator";

export class RefreshTokenDto {
  /**
   * Optional in browser flows — the cookie `pc_refresh` is used instead.
   * Non-browser clients (mobile, scripts) still send it in the body.
   */
  @IsOptional()
  @IsString()
  @MinLength(16)
  refreshToken?: string;
}
