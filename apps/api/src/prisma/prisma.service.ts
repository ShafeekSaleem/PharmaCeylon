import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { createTenantAwarePrismaProxy } from "./tenant-aware-prisma.proxy";

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(configService: ConfigService) {
    const connectionString = configService.getOrThrow<string>("DATABASE_URL");
    const adapter = new PrismaPg({ connectionString });
    super({ adapter });
    return createTenantAwarePrismaProxy(this);
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
