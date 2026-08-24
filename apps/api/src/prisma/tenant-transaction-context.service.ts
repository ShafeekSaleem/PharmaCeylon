import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "./prisma.service";

export type TenantTransactionScope = {
  tenantId: string;
  branchId?: string;
};

type ActiveTenantTransaction = TenantTransactionScope & {
  client: Prisma.TransactionClient;
};

/**
 * Holds the Prisma transaction that owns PostgreSQL's transaction-local RLS
 * settings. Consumers must use `client` while a scope is active; using the
 * root PrismaService could run on a different pooled connection.
 *
 * This is Phase 3 infrastructure only. Production RLS stays disabled until all
 * tenant-aware data access paths have migrated to this client.
 */
@Injectable()
export class TenantTransactionContext {
  private readonly storage = new AsyncLocalStorage<ActiveTenantTransaction>();

  constructor(private readonly prisma: PrismaService) {}

  /** Current transaction client, or the root client outside a tenant transaction. */
  get client(): Prisma.TransactionClient {
    return this.storage.getStore()?.client ?? this.prisma;
  }

  get scope(): TenantTransactionScope | null {
    const active = this.storage.getStore();
    return active
      ? { tenantId: active.tenantId, ...(active.branchId ? { branchId: active.branchId } : {}) }
      : null;
  }

  get isActive(): boolean {
    return this.storage.getStore() != null;
  }

  /**
   * Execute work on one database connection with tenant/branch settings that
   * PostgreSQL automatically clears at transaction end.
   */
  async run<T>(
    scope: TenantTransactionScope,
    work: (client: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const tenantId = scope.tenantId.trim();
    const branchId = scope.branchId?.trim() || undefined;
    if (!tenantId) throw new Error("Tenant transaction requires tenantId");

    const active = this.storage.getStore();
    if (active) {
      if (active.tenantId !== tenantId || active.branchId !== branchId) {
        throw new Error("Cannot change tenant or branch inside an active tenant transaction");
      }
      return work(active.client);
    }

    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          "SELECT set_config('app.tenant_id', $1, true)",
          tenantId,
        );
        await tx.$executeRawUnsafe(
          "SELECT set_config('app.branch_id', $1, true)",
          branchId ?? "",
        );

        return this.storage.run(
          { tenantId, ...(branchId ? { branchId } : {}), client: tx },
          () => work(tx),
        );
      },
      {
        maxWait: 5_000,
        timeout: 30_000,
      },
    );
  }
}
