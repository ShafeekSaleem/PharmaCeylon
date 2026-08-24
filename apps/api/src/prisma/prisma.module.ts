import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { TenantTransactionContext } from "./tenant-transaction-context.service";

@Global()
@Module({
  providers: [PrismaService, TenantTransactionContext],
  exports: [PrismaService, TenantTransactionContext],
})
export class PrismaModule {}
