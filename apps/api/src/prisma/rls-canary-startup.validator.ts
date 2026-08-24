import { Injectable, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "./prisma.service";

type CanaryDatabaseState = {
  role_name: string;
  role_is_superuser: boolean;
  role_bypasses_rls: boolean;
  owns_canary_table: boolean;
  canary_table_count: number;
  all_rls_enabled: boolean;
  all_rls_forced: boolean;
};

/**
 * Fail-closed gate for environments that explicitly declare the RLS canary
 * enforced. The API must not start if its role can bypass policies, owns a
 * canary table, or the database activation is incomplete.
 */
@Injectable()
export class RlsCanaryStartupValidator implements OnModuleInit {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    const enforced =
      this.config.get<string>("RLS_CANARY_ENFORCED", "false") === "true";
    if (!enforced) return;

    const transactionContextEnabled =
      this.config.get<string>("TENANT_TRANSACTION_CONTEXT_ENABLED", "false") ===
      "true";
    if (!transactionContextEnabled) {
      throw new Error(
        "RLS_CANARY_ENFORCED requires TENANT_TRANSACTION_CONTEXT_ENABLED=true",
      );
    }

    const rows = await this.prisma.$queryRawUnsafe<CanaryDatabaseState[]>(`
      SELECT current_user AS role_name,
             r.rolsuper AS role_is_superuser,
             r.rolbypassrls AS role_bypasses_rls,
             bool_or(pg_get_userbyid(c.relowner) = current_user) AS owns_canary_table,
             count(*)::int AS canary_table_count,
             bool_and(c.relrowsecurity) AS all_rls_enabled,
             bool_and(c.relforcerowsecurity) AS all_rls_forced
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_roles r ON r.rolname = current_user
       WHERE n.nspname = 'public'
         AND c.relname = ANY(ARRAY['product', 'batch', 'sale'])
       GROUP BY current_user, r.rolsuper, r.rolbypassrls
    `);

    const state = rows[0];
    if (!state || state.canary_table_count !== 3) {
      throw new Error("RLS canary requires product, batch, and sale tables");
    }
    if (state.role_is_superuser || state.role_bypasses_rls) {
      throw new Error(
        `RLS canary application role ${state.role_name} can bypass row security`,
      );
    }
    if (state.owns_canary_table) {
      throw new Error(
        `RLS canary application role ${state.role_name} owns a canary table`,
      );
    }
    if (!state.all_rls_enabled || !state.all_rls_forced) {
      throw new Error(
        "RLS canary is declared enforced but product, batch, and sale are not ENABLE/FORCE RLS",
      );
    }
  }
}
