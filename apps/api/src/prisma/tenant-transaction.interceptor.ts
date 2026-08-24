import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Observable, from, lastValueFrom } from "rxjs";
import { AuthenticatedRequest } from "../security/interfaces/authenticated-request.interface";
import { TenantTransactionContext } from "./tenant-transaction-context.service";

/**
 * Opt-in request boundary for the RLS canary rollout.
 *
 * Guards run first, so authenticated tenant and validated branch context are
 * available here. Disabled by default until canary policies are activated in a
 * controlled environment.
 */
@Injectable()
export class TenantTransactionInterceptor implements NestInterceptor {
  private readonly enabled: boolean;

  constructor(
    config: ConfigService,
    private readonly tenantTransactions: TenantTransactionContext,
  ) {
    this.enabled =
      config.get<string>("TENANT_TRANSACTION_CONTEXT_ENABLED", "false") === "true";
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!this.enabled || !request.user) {
      return next.handle();
    }

    return from(
      this.tenantTransactions.run(
        {
          tenantId: request.user.tenantId,
          ...(request.branchId ? { branchId: request.branchId } : {}),
        },
        async () => lastValueFrom(next.handle()),
      ),
    );
  }
}
