import { Injectable } from "@nestjs/common";
import type { CounterJournalSyncStatus } from "@pharmaceylon/shared";
import { safeTimeZone } from "../../common/business-date.util";
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

  list(user: RequestUser, branchId: string): Promise<CounterJournalSyncStatus> {
    return this.prisma.$transaction(async (tx) => {
      const access = await this.access.resolveLive(user, uuid(branchId), tx);
      if (!access.has("tenant.management")) denied("PERMISSION_DENIED");
      const branch = await tx.branch.findFirst({
        where: { tenantId: user.tenantId, id: branchId },
        select: { timezone: true },
      });
      // One statement reads one snapshot: a head that moves meanwhile can't count twice.
      const rows = await tx.$queryRaw<JournalStatusRow[]>(
        journalStatusQuery(user.tenantId, branchId),
      );
      return {
        timezone: safeTimeZone(branch?.timezone),
        enrollments: journalSyncViews(rows),
      };
    });
  }
}
