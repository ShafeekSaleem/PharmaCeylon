import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { RoleName } from "@prisma/client";
import request from "supertest";
import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { PrismaService } from "../prisma/prisma.service";

describe("Security Guards", () => {
  let app: INestApplication;
  let jwtService: JwtService;

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET = "change-me-access";

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(AuthService)
      .useValue({
        login: jest.fn(),
        refresh: jest.fn(),
        getMe: jest.fn().mockResolvedValue({ ok: true }),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
    jwtService = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  const signAccessToken = (roles: Array<{ branchId: string; role: RoleName }>) =>
    jwtService.sign(
      {
        sub: "user-1",
        tenantId: "tenant-1",
        email: "demo@pharma.com",
        branchRoles: roles,
        type: "access",
      },
      {
        secret: "change-me-access",
      },
    );

  it("allows public health endpoint without token", async () => {
    await request(app.getHttpServer()).get("/api/v1/health").expect(200);
  });

  it("blocks protected endpoint without token", async () => {
    await request(app.getHttpServer()).get("/api/v1/tenant/context").expect(401);
  });

  it("allows tenant context with valid token", async () => {
    const token = signAccessToken([{ branchId: "b1", role: RoleName.cashier }]);
    await request(app.getHttpServer())
      .get("/api/v1/tenant/context")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
  });

  it("blocks management endpoint for cashier role", async () => {
    const token = signAccessToken([{ branchId: "b1", role: RoleName.cashier }]);
    await request(app.getHttpServer())
      .get("/api/v1/tenant/management")
      .set("Authorization", `Bearer ${token}`)
      .set("x-branch-id", "b1")
      .expect(403);
  });

  it("allows management endpoint for manager role", async () => {
    const token = signAccessToken([{ branchId: "b1", role: RoleName.manager }]);
    await request(app.getHttpServer())
      .get("/api/v1/tenant/management")
      .set("Authorization", `Bearer ${token}`)
      .set("x-branch-id", "b1")
      .expect(200);
  });

  it("blocks access when branch header is unauthorized", async () => {
    const token = signAccessToken([{ branchId: "b1", role: RoleName.manager }]);
    await request(app.getHttpServer())
      .get("/api/v1/tenant/context")
      .set("Authorization", `Bearer ${token}`)
      .set("x-branch-id", "different-branch")
      .expect(403);
  });
});
