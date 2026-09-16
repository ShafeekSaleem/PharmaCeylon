import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

export type AuditInput = {
  tenantId: string;
  branchId?: string | null;
  actorUserId?: string | null;
  eventName: string;
  entityName: string;
  entityId: string;
  payload?: Prisma.InputJsonValue;
};

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Pass the transaction client when the event describes a change made in that transaction.
   * Written through the root client instead, the event commits on its own connection: a
   * rolled-back goods receipt still left "goods_receipt.posted" in the log.
   */
  async log(input: AuditInput, client: Prisma.TransactionClient = this.prisma) {
    await client.auditEvent.create({
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
