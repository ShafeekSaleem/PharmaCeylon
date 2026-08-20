import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { RoleName } from "@prisma/client";
import cookieParser from "cookie-parser";
import request from "supertest";
import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { ACCESS_COOKIE, CSRF_COOKIE } from "../auth/cookies";
import { UserContextService } from "../auth/user-context.service";
import { PrismaService } from "../prisma/prisma.service";

describe("Security Guards", () => {
  let app: INestApplication;
  let jwtService: JwtService;
  let userContext: { load: jest.Mock };
  let rolePermissionFindMany: jest.Mock;

  const baseCtx = {
    userId: "user-1",
    tenantId: "tenant-1",
    email: "demo@pharma.com",
    fullName: "Demo User",
    isActive: true,
    tokenVersion: 0,
    branchRoles: [{ branchId: "b1", role: RoleName.cashier }],
  };

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET = "change-me-access";
    process.env.COOKIE_SAMESITE = "lax";
    process.env.COOKIE_SECURE = "false";

    userContext = { load: jest.fn() };
    rolePermissionFindMany = jest.fn().mockResolvedValue([]);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({
        $queryRawUnsafe: jest.fn().mockResolvedValue([{ "?column?": 1 }]),
        branch: {
          findMany: jest.fn().mockResolvedValue([]),
        },
        rolePermission: {
          findMany: rolePermissionFindMany,
        },
      })
      .overrideProvider(AuthService)
      .useValue({
        login: jest.fn(),
        refresh: jest.fn(),
        logout: jest.fn(),
        logoutAll: jest.fn(),
        getMe: jest.fn().mockResolvedValue({ ok: true }),
      })
      .overrideProvider(UserContextService)
      .useValue(userContext)
      .compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix("api/v1");
    await app.init();
    jwtService = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    userContext.load.mockReset();
    rolePermissionFindMany.mockReset().mockResolvedValue([]);
  });

  const signAccessToken = (
    overrides: Partial<{ sub: string; tenantId: string; tokenVersion: number }> = {},
  ) =>
    jwtService.sign(
      {
        sub: overrides.sub ?? "user-1",
        tenantId: overrides.tenantId ?? "tenant-1",
        tokenVersion: overrides.tokenVersion ?? 0,
        type: "access",
      },
      { secret: "change-me-access" },
    );

  it("allows public health endpoint without a token", async () => {
    await request(app.getHttpServer()).get("/api/v1/health").expect(200);
  });

  it("blocks protected endpoints without a token", async () => {
    await request(app.getHttpServer()).get("/api/v1/tenant/context").expect(401);
  });

  it("authenticates via Bearer header and skips CSRF", async () => {
    userContext.load.mockResolvedValue(baseCtx);
    const token = signAccessToken();
    await request(app.getHttpServer())
      .get("/api/v1/tenant/context")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
  });

  it("authenticates via httpOnly cookie", async () => {
    userContext.load.mockResolvedValue(baseCtx);
    const token = signAccessToken();
    await request(app.getHttpServer())
      .get("/api/v1/tenant/context")
      .set("Cookie", `${ACCESS_COOKIE}=${token}`)
      .expect(200);
  });

  it("rejects access tokens whose tokenVersion is stale (admin invalidation)", async () => {
    userContext.load.mockResolvedValue({ ...baseCtx, tokenVersion: 5 });
    const token = signAccessToken({ tokenVersion: 0 });
    await request(app.getHttpServer())
      .get("/api/v1/tenant/context")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);
  });

  it("returns 401 when the user context is missing or inactive", async () => {
    userContext.load.mockResolvedValue({ ...baseCtx, isActive: false });
    const token = signAccessToken();
    await request(app.getHttpServer())
      .get("/api/v1/tenant/context")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);
  });

  it("blocks state-changing requests authed via cookie without a CSRF header", async () => {
    userContext.load.mockResolvedValue(baseCtx);
    const token = signAccessToken();
    await request(app.getHttpServer())
      .post("/api/v1/auth/logout")
      .set("Cookie", [`${ACCESS_COOKIE}=${token}`, `${CSRF_COOKIE}=expected`])
      .expect(403);
  });

  it("allows state-changing cookie-authed requests when the CSRF header matches the cookie", async () => {
    userContext.load.mockResolvedValue(baseCtx);
    const token = signAccessToken();
    await request(app.getHttpServer())
      .post("/api/v1/auth/logout")
      .set("Cookie", [`${ACCESS_COOKIE}=${token}`, `${CSRF_COOKIE}=expected`])
      .set("X-CSRF-Token", "expected")
      .expect(204);
  });

  it("does NOT require CSRF for Bearer-authed mutations (no cookie ⇒ no CSRF surface)", async () => {
    userContext.load.mockResolvedValue(baseCtx);
    const token = signAccessToken();
    await request(app.getHttpServer())
      .post("/api/v1/auth/logout")
      .set("Authorization", `Bearer ${token}`)
      .expect(204);
  });

  it("blocks the management endpoint for cashier role", async () => {
    userContext.load.mockResolvedValue({
      ...baseCtx,
      branchRoles: [{ branchId: "b1", role: RoleName.cashier }],
    });
    const token = signAccessToken();
    await request(app.getHttpServer())
      .get("/api/v1/tenant/management")
      .set("Authorization", `Bearer ${token}`)
      .set("x-branch-id", "b1")
      .expect(403);
  });

  it("allows the management endpoint for manager role", async () => {
    userContext.load.mockResolvedValue({
      ...baseCtx,
      branchRoles: [{ branchId: "b1", role: RoleName.manager }],
    });
    const token = signAccessToken();
    await request(app.getHttpServer())
      .get("/api/v1/tenant/management")
      .set("Authorization", `Bearer ${token}`)
      .set("x-branch-id", "b1")
      .expect(200);
  });

  it("blocks access when x-branch-id refers to a branch the user has no role in", async () => {
    userContext.load.mockResolvedValue({
      ...baseCtx,
      branchRoles: [{ branchId: "b1", role: RoleName.manager }],
    });
    const token = signAccessToken();
    await request(app.getHttpServer())
      .get("/api/v1/tenant/context")
      .set("Authorization", `Bearer ${token}`)
      .set("x-branch-id", "different-branch")
      .expect(403);
  });

  it("blocks a custom role with no matching grant even though it has a roleId", async () => {
    userContext.load.mockResolvedValue({
      ...baseCtx,
      branchRoles: [{ branchId: "b1", role: RoleName.custom, roleId: "custom-role-1" }],
    });
    rolePermissionFindMany.mockResolvedValue([{ permissionKey: "reports.view" }]);
    const token = signAccessToken();
    await request(app.getHttpServer())
      .get("/api/v1/tenant/management")
      .set("Authorization", `Bearer ${token}`)
      .set("x-branch-id", "b1")
      .expect(403);
    expect(rolePermissionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { roleId: "custom-role-1" } }),
    );
  });

  it("allows a custom role whose Role has been granted the required permission", async () => {
    userContext.load.mockResolvedValue({
      ...baseCtx,
      branchRoles: [{ branchId: "b1", role: RoleName.custom, roleId: "custom-role-2" }],
    });
    rolePermissionFindMany.mockResolvedValue([{ permissionKey: "tenant.management" }]);
    const token = signAccessToken();
    await request(app.getHttpServer())
      .get("/api/v1/tenant/management")
      .set("Authorization", `Bearer ${token}`)
      .set("x-branch-id", "b1")
      .expect(200);
  });
});
