import { Prisma } from "@prisma/client";
import { tenantTransactionStorage } from "./tenant-transaction.store";

type TransactionCallback<T> = (client: Prisma.TransactionClient) => Promise<T>;

/**
 * Routes existing PrismaService delegate access to the active request
 * transaction. This keeps all current services on one pooled connection while
 * an RLS scope is active, without duplicating every Prisma delegate.
 */
export function createTenantAwarePrismaProxy<T extends object>(root: T): T {
  return new Proxy(root, {
    get(target, property) {
      const active = tenantTransactionStorage.getStore();

      if (active && property === "$transaction") {
        return async <R>(
          input: TransactionCallback<R> | Array<Promise<unknown>>,
        ): Promise<R | unknown[]> => {
          if (Array.isArray(input)) return Promise.all(input);
          return input(active.client);
        };
      }

      if (active && property in active.client) {
        const value = Reflect.get(active.client, property, active.client) as unknown;
        return typeof value === "function"
          ? value.bind(active.client)
          : value;
      }

      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
