import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { AppUser, RoleName } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { PrismaService } from "../prisma/prisma.service";
import { LoginDto } from "./dto/login.dto";
import { RefreshTokenDto } from "./dto/refresh-token.dto";
import { AuthTokenPayload, BranchRolePayload } from "./types/auth-token-payload.type";

type TokenPair = {
  accessToken: string;
  refreshToken: string;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async login(dto: LoginDto) {
    const tenantCode = dto.tenantCode.trim().toLowerCase();

    const user = await this.prisma.appUser.findFirst({
      where: {
        email: dto.email.toLowerCase(),
        isActive: true,
        tenant: {
          code: tenantCode,
          isActive: true,
        },
      },
      include: {
        tenant: { select: { code: true } },
        userBranchRoles: {
          select: {
            branchId: true,
            role: true,
          },
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const passwordValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordValid) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const tokens = await this.issueTokens(user);
    await this.persistRefreshTokenHash(user.id, tokens.refreshToken);

    return {
      user: this.mapUser(user),
      ...tokens,
    };
  }

  async refresh(dto: RefreshTokenDto) {
    const payload = await this.verifyRefreshToken(dto.refreshToken);
    const user = await this.prisma.appUser.findUnique({
      where: { id: payload.sub },
      include: {
        tenant: { select: { code: true } },
        userBranchRoles: {
          select: {
            branchId: true,
            role: true,
          },
        },
      },
    });

    if (!user || !user.isActive || !user.refreshTokenHash) {
      throw new UnauthorizedException("Invalid refresh token");
    }

    const refreshValid = await bcrypt.compare(dto.refreshToken, user.refreshTokenHash);
    if (!refreshValid) {
      throw new UnauthorizedException("Invalid refresh token");
    }

    const tokens = await this.issueTokens(user);
    await this.persistRefreshTokenHash(user.id, tokens.refreshToken);

    return {
      user: this.mapUser(user),
      ...tokens,
    };
  }

  async getMe(userId: string) {
    const user = await this.prisma.appUser.findUnique({
      where: { id: userId },
      include: {
        userBranchRoles: {
          select: { branchId: true, role: true },
        },
      },
    });
    if (!user) {
      throw new UnauthorizedException("User not found");
    }
    return this.mapUser(user);
  }

  private async issueTokens(
    user: AppUser & { userBranchRoles: BranchRolePayload[]; tenant?: { code: string } },
  ): Promise<TokenPair> {
    const payload: Omit<AuthTokenPayload, "type"> = {
      sub: user.id,
      tenantId: user.tenantId,
      email: user.email,
      branchRoles: user.userBranchRoles,
    };

    const accessToken = await this.jwtService.signAsync(
      { ...payload, type: "access" },
      {
        secret: this.configService.getOrThrow<string>("JWT_ACCESS_SECRET"),
        expiresIn: Number(this.configService.get("JWT_ACCESS_TTL_SECONDS", 900)),
      },
    );

    const refreshToken = await this.jwtService.signAsync(
      { ...payload, type: "refresh" },
      {
        secret: this.configService.getOrThrow<string>("JWT_REFRESH_SECRET"),
        expiresIn: Number(this.configService.get("JWT_REFRESH_TTL_SECONDS", 1209600)),
      },
    );

    return { accessToken, refreshToken };
  }

  private async verifyRefreshToken(token: string): Promise<AuthTokenPayload> {
    try {
      const payload = await this.jwtService.verifyAsync<AuthTokenPayload>(token, {
        secret: this.configService.getOrThrow<string>("JWT_REFRESH_SECRET"),
      });
      if (payload.type !== "refresh") {
        throw new UnauthorizedException("Invalid refresh token");
      }
      return payload;
    } catch {
      throw new UnauthorizedException("Invalid refresh token");
    }
  }

  private async persistRefreshTokenHash(userId: string, refreshToken: string) {
    const hash = await bcrypt.hash(refreshToken, 10);
    await this.prisma.appUser.update({
      where: { id: userId },
      data: { refreshTokenHash: hash },
    });
  }

  private mapUser(user: AppUser & { userBranchRoles: BranchRolePayload[]; tenant?: { code: string } }) {
    const roleSet = new Set<RoleName>(user.userBranchRoles.map((x) => x.role));
    return {
      id: user.id,
      tenantId: user.tenantId,
      tenantCode: user.tenant?.code,
      email: user.email,
      fullName: user.fullName,
      roles: Array.from(roleSet),
      branchRoles: user.userBranchRoles,
    };
  }
}
