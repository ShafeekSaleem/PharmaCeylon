import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "@prisma/client";

export type TenantTransactionScope = {
  tenantId: string;
  branchId?: string;
};

export type ActiveTenantTransaction = TenantTransactionScope & {
  client: Prisma.TransactionClient;
};

/**
 * Process-local carrier for the transaction that owns PostgreSQL SET LOCAL
 * values. Kept outside Nest DI so PrismaService's proxy can resolve the active
 * client without creating a circular dependency.
 */
export const tenantTransactionStorage =
  new AsyncLocalStorage<ActiveTenantTransaction>();
