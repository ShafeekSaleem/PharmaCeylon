import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { RlsCanaryStartupValidator } from "./rls-canary-startup.validator";
import { TenantTransactionContext } from "./tenant-transaction-context.service";

@Global()
@Module({
  providers: [
    PrismaService,
    TenantTransactionContext,
    RlsCanaryStartupValidator,
  ],
  exports: [PrismaService, TenantTransactionContext],
})
export class PrismaModule {}
