import { INestApplication, Logger } from "@nestjs/common";
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
  let userContext: { load: jest.Mock; openCounterSession: jest.Mock };
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

    userContext = { load: jest.fn(), openCounterSession: jest.fn() };
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
    userContext.openCounterSession.mockReset();
    rolePermissionFindMany.mockReset().mockResolvedValue([]);
  });

  const signAccessToken = (
    overrides: Partial<{
      sub: string;
      tenantId: string;
      tokenVersion: number;
      counterSessionId: string;
    }> = {},
  ) =>
    jwtService.sign(
      {
        sub: overrides.sub ?? "user-1",
        tenantId: overrides.tenantId ?? "tenant-1",
        tokenVersion: overrides.tokenVersion ?? 0,
        type: "access",
        ...(overrides.counterSessionId
          ? { counterSessionId: overrides.counterSessionId }
          : {}),
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

  describe("a login opened by a PIN at a counter", () => {
    const counterToken = () =>
      signAccessToken({ counterSessionId: "work-session-1" });

    it("reaches a counter route while its staff session is open", async () => {
      userContext.load.mockResolvedValue(baseCtx);
      userContext.openCounterSession.mockResolvedValue({ branchId: "b1" });
      await request(app.getHttpServer())
        .post("/api/v1/auth/logout")
        .set("Authorization", `Bearer ${counterToken()}`)
        .expect(204);
      expect(userContext.openCounterSession).toHaveBeenCalledWith(
        "work-session-1",
        "user-1",
        "tenant-1",
      );
    });

    it("is refused on any route not marked for the counter, without a refresh-provoking 401", async () => {
      userContext.load.mockResolvedValue({
        ...baseCtx,
        branchRoles: [{ branchId: "b1", role: RoleName.manager }],
      });
      userContext.openCounterSession.mockResolvedValue({ branchId: "b1" });
      const res = await request(app.getHttpServer())
        .get("/api/v1/tenant/management")
        .set("Authorization", `Bearer ${counterToken()}`)
        .set("x-branch-id", "b1")
        .expect(403);
      expect(res.body.code).toBe("COUNTER_SESSION_ONLY");
    });

    it("stops working once the counter staff session is closed", async () => {
      userContext.load.mockResolvedValue(baseCtx);
      userContext.openCounterSession.mockResolvedValue(null);
      await request(app.getHttpServer())
        .post("/api/v1/auth/logout")
        .set("Authorization", `Bearer ${counterToken()}`)
        .expect(401);
    });

    it("is held to the counter's branch, whatever branch header is sent", async () => {
      userContext.load.mockResolvedValue({
        ...baseCtx,
        branchRoles: [
          { branchId: "b1", role: RoleName.cashier },
          { branchId: "b2", role: RoleName.cashier },
        ],
      });
      userContext.openCounterSession.mockResolvedValue({ branchId: "b1" });
      await request(app.getHttpServer())
        .post("/api/v1/auth/logout")
        .set("Authorization", `Bearer ${counterToken()}`)
        .set("x-branch-id", "b2")
        .expect(403);
    });

    it("is scoped to the counter's branch even without a header, so losing that role ends it", async () => {
      userContext.load.mockResolvedValue({
        ...baseCtx,
        branchRoles: [{ branchId: "b2", role: RoleName.cashier }],
      });
      userContext.openCounterSession.mockResolvedValue({ branchId: "b1" });
      await request(app.getHttpServer())
        .post("/api/v1/auth/logout")
        .set("Authorization", `Bearer ${counterToken()}`)
        .expect(403);
    });

    it("leaves password logins untouched by the counter checks", async () => {
      userContext.load.mockResolvedValue(baseCtx);
      await request(app.getHttpServer())
        .get("/api/v1/tenant/context")
        .set("Authorization", `Bearer ${signAccessToken()}`)
        .expect(200);
      expect(userContext.openCounterSession).not.toHaveBeenCalled();
    });
  });

  /** Guard refusals happen before any terminal code runs; the terminal routes' filter still
   * shapes them, so the desktop reads one body for every refusal. */
  describe("terminal routes answer guard refusals with the shared TerminalApiError", () => {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    });
    afterEach(() => warn.mockRestore());

    it("gives a missing token AUTHENTICATION_REQUIRED, logging the same correlation ID", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/terminal-commands/execute")
        .send({})
        .expect(401);
      expect(res.body).toEqual({
        statusCode: 401,
        error: "Unauthorized",
        contractVersion: 1,
        code: "AUTHENTICATION_REQUIRED",
        message: "Missing access token",
        correlationId: expect.stringMatching(UUID),
        retryable: false,
      });
      const lines = warn.mock.calls.map(([line]) => String(line));
      expect(lines).toEqual([
        `terminal.error ${JSON.stringify({
          correlationId: res.body.correlationId,
          status: 401,
          code: "AUTHENTICATION_REQUIRED",
          method: "POST",
          route: "/api/v1/terminal-commands/execute",
        })}`,
      ]);
    });

    it("leaves the platform body on routes outside the terminal modules", async () => {
      const res = await request(app.getHttpServer()).get("/api/v1/tenant/context").expect(401);
      expect(res.body).toEqual({
        statusCode: 401,
        error: "Unauthorized",
        message: "Missing access token",
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it("gives a permission refusal with no code of its own FORBIDDEN", async () => {
      userContext.load.mockResolvedValue(baseCtx);
      const res = await request(app.getHttpServer())
        .get("/api/v1/terminals/counters")
        .set("Authorization", `Bearer ${signAccessToken()}`)
        .set("x-branch-id", "b1")
        .expect(403);
      expect(res.body).toMatchObject({
        contractVersion: 1,
        code: "FORBIDDEN",
        message: "Insufficient permissions",
        retryable: false,
      });
    });

    it("keeps a coded refusal's code and message", async () => {
      userContext.load.mockResolvedValue({
        ...baseCtx,
        branchRoles: [{ branchId: "b1", role: RoleName.manager }],
      });
      userContext.openCounterSession.mockResolvedValue({ branchId: "b1" });
      const res = await request(app.getHttpServer())
        .get("/api/v1/terminals/counters")
        .set("Authorization", `Bearer ${signAccessToken({ counterSessionId: "work-session-1" })}`)
        .set("x-branch-id", "b1")
        .expect(403);
      expect(res.body).toEqual({
        statusCode: 403,
        contractVersion: 1,
        code: "COUNTER_SESSION_ONLY",
        message: "Sign in with your email and password to do this.",
        correlationId: expect.stringMatching(UUID),
        retryable: false,
      });
    });
  });
});
