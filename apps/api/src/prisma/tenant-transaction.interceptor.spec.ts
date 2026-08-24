import { CallHandler, ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { lastValueFrom, of, throwError } from "rxjs";
import { TenantTransactionContext } from "./tenant-transaction-context.service";
import { TenantTransactionInterceptor } from "./tenant-transaction.interceptor";

function executionContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe("TenantTransactionInterceptor", () => {
  const transactions = {
    run: jest.fn(async (_scope: unknown, work: () => Promise<unknown>) => work()),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does not open a transaction while the canary flag is disabled", async () => {
    const interceptor = new TenantTransactionInterceptor(
      { get: jest.fn().mockReturnValue("false") } as unknown as ConfigService,
      transactions as unknown as TenantTransactionContext,
    );
    const next = { handle: jest.fn(() => of("ok")) } as CallHandler;

    await expect(lastValueFrom(interceptor.intercept(executionContext({}), next))).resolves.toBe(
      "ok",
    );
    expect(transactions.run).not.toHaveBeenCalled();
  });

  it("skips public and pre-authentication requests without a user context", async () => {
    const interceptor = new TenantTransactionInterceptor(
      { get: jest.fn().mockReturnValue("true") } as unknown as ConfigService,
      transactions as unknown as TenantTransactionContext,
    );
    const next = { handle: jest.fn(() => of("public")) } as CallHandler;

    await expect(lastValueFrom(interceptor.intercept(executionContext({}), next))).resolves.toBe(
      "public",
    );
    expect(transactions.run).not.toHaveBeenCalled();
  });

  it("wraps authenticated work with the verified tenant and branch", async () => {
    const interceptor = new TenantTransactionInterceptor(
      { get: jest.fn().mockReturnValue("true") } as unknown as ConfigService,
      transactions as unknown as TenantTransactionContext,
    );
    const request = {
      user: { tenantId: "tenant-1" },
      branchId: "branch-1",
    };
    const next = { handle: jest.fn(() => of({ ok: true })) } as CallHandler;

    await expect(
      lastValueFrom(interceptor.intercept(executionContext(request), next)),
    ).resolves.toEqual({ ok: true });

    expect(transactions.run).toHaveBeenCalledWith(
      { tenantId: "tenant-1", branchId: "branch-1" },
      expect.any(Function),
    );
  });

  it("propagates handler errors through the transaction boundary", async () => {
    const interceptor = new TenantTransactionInterceptor(
      { get: jest.fn().mockReturnValue("true") } as unknown as ConfigService,
      transactions as unknown as TenantTransactionContext,
    );
    const request = { user: { tenantId: "tenant-1" } };
    const next = {
      handle: jest.fn(() => throwError(() => new Error("handler failed"))),
    } as CallHandler;

    await expect(
      lastValueFrom(interceptor.intercept(executionContext(request), next)),
    ).rejects.toThrow("handler failed");
  });
});
