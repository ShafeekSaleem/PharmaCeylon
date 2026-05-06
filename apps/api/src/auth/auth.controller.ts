import { Body, Controller, Get, Post } from "@nestjs/common";
import { Public } from "../security/decorators/public.decorator";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { AuthService } from "./auth.service";
import { LoginDto } from "./dto/login.dto";
import { RefreshTokenDto } from "./dto/refresh-token.dto";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post("login")
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Public()
  @Post("refresh")
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto);
  }

  @Get("me")
  me(@CurrentUser() user: RequestUser) {
    return this.authService.getMe(user.userId);
  }
}
