import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { CounterJournalSyncView } from "@pharmaceylon/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { AccessService } from "../../security/access.service";
import type { RequestUser } from "../../security/interfaces/authenticated-request.interface";
import { denied, uuid } from "../terminal-wire";
import {
  journalStatusQuery,
  journalSyncViews,
  type JournalStatusRow,
} from "./counter-journal-status";

/**
 * P5 #51: how far each counter's offline journal has reached the server, for the managers who
 * look after the counters (the web Counters page). Read-only, from the server's own receipts,
 * retained refusals, sign-ins and stock cases: the counter's word is not needed or trusted.
 */
@Injectable()
export class CounterJournalStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  list(user: RequestUser, branchId: string): Promise<CounterJournalSyncView[]> {
    return this.prisma.$transaction(
      async (tx) => {
        const access = await this.access.resolveLive(user, uuid(branchId), tx);
        if (!access.has("tenant.management")) denied("PERMISSION_DENIED");
        const rows = await tx.$queryRaw<JournalStatusRow[]>(
          journalStatusQuery(user.tenantId, branchId),
        );
        return journalSyncViews(rows);
      },
      // One snapshot: a head that moves mid-read can't count an accepted entry as still waiting.
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
