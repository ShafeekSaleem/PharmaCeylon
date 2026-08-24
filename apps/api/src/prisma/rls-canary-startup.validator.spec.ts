import { ConfigService } from "@nestjs/config";
import { PrismaService } from "./prisma.service";
import { RlsCanaryStartupValidator } from "./rls-canary-startup.validator";

describe("RlsCanaryStartupValidator", () => {
  const query = jest.fn();
  const prisma = {
    $queryRawUnsafe: query,
  } as unknown as PrismaService;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function config(values: Record<string, string>): ConfigService {
    return {
      get: jest.fn((key: string, fallback: string) => values[key] ?? fallback),
    } as unknown as ConfigService;
  }

  it("does not inspect the database when enforcement is disabled", async () => {
    const validator = new RlsCanaryStartupValidator(config({}), prisma);

    await expect(validator.onModuleInit()).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it("requires the request transaction boundary", async () => {
    const validator = new RlsCanaryStartupValidator(
      config({ RLS_CANARY_ENFORCED: "true" }),
      prisma,
    );

    await expect(validator.onModuleInit()).rejects.toThrow(
      "TENANT_TRANSACTION_CONTEXT_ENABLED=true",
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("accepts a non-owner NOBYPASSRLS role with all canaries forced", async () => {
    query.mockResolvedValue([
      {
        role_name: "pharmaceylon_app",
        role_is_superuser: false,
        role_bypasses_rls: false,
        owns_canary_table: false,
        canary_table_count: 3,
        all_rls_enabled: true,
        all_rls_forced: true,
      },
    ]);
    const validator = new RlsCanaryStartupValidator(
      config({
        RLS_CANARY_ENFORCED: "true",
        TENANT_TRANSACTION_CONTEXT_ENABLED: "true",
      }),
      prisma,
    );

    await expect(validator.onModuleInit()).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "a superuser",
      { role_is_superuser: true },
      "can bypass row security",
    ],
    [
      "a BYPASSRLS role",
      { role_bypasses_rls: true },
      "can bypass row security",
    ],
    [
      "a table owner",
      { owns_canary_table: true },
      "owns a canary table",
    ],
    [
      "partially enabled policies",
      { all_rls_forced: false },
      "not ENABLE/FORCE RLS",
    ],
  ])("rejects %s", async (_label, override, expected) => {
    query.mockResolvedValue([
      {
        role_name: "unsafe_role",
        role_is_superuser: false,
        role_bypasses_rls: false,
        owns_canary_table: false,
        canary_table_count: 3,
        all_rls_enabled: true,
        all_rls_forced: true,
        ...override,
      },
    ]);
    const validator = new RlsCanaryStartupValidator(
      config({
        RLS_CANARY_ENFORCED: "true",
        TENANT_TRANSACTION_CONTEXT_ENABLED: "true",
      }),
      prisma,
    );

    await expect(validator.onModuleInit()).rejects.toThrow(expected);
  });

  it("rejects an incomplete canary table inventory", async () => {
    query.mockResolvedValue([
      {
        role_name: "pharmaceylon_app",
        role_is_superuser: false,
        role_bypasses_rls: false,
        owns_canary_table: false,
        canary_table_count: 2,
        all_rls_enabled: true,
        all_rls_forced: true,
      },
    ]);
    const validator = new RlsCanaryStartupValidator(
      config({
        RLS_CANARY_ENFORCED: "true",
        TENANT_TRANSACTION_CONTEXT_ENABLED: "true",
      }),
      prisma,
    );

    await expect(validator.onModuleInit()).rejects.toThrow(
      "requires product, batch, and sale tables",
    );
  });
});
