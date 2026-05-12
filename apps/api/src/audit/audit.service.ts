import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(input: {
    tenantId: string;
    branchId?: string | null;
    actorUserId?: string | null;
    eventName: string;
    entityName: string;
    entityId: string;
    payload?: Prisma.InputJsonValue;
  }) {
    await this.prisma.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        branchId: input.branchId ?? null,
        actorUserId: input.actorUserId ?? null,
        eventName: input.eventName,
        entityName: input.entityName,
        entityId: input.entityId,
        payload: input.payload ?? {},
      },
    });
  }
}
