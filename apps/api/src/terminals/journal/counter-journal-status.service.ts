import { Injectable } from "@nestjs/common";
import type { CounterJournalSyncStatus } from "@pharmaceylon/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { AccessService } from "../../security/access.service";
import type { RequestUser } from "../../security/interfaces/authenticated-request.interface";
import { denied, uuid } from "../terminal-wire";
import {
  journalStatusQuery,
  journalSyncViews,
  type JournalStatusRow,
} from "./counter-journal-status";
import { branchTimeZone } from "./branch-time-zone";

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
      const timezone = await branchTimeZone(tx, user.tenantId, branchId);
      // One statement reads one snapshot: a head that moves meanwhile can't count twice.
      const rows = await tx.$queryRaw<JournalStatusRow[]>(
        journalStatusQuery(user.tenantId, branchId),
      );
      return {
        timezone,
        enrollments: journalSyncViews(rows),
      };
    });
  }
}
