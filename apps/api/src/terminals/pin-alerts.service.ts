import { Injectable, Logger } from "@nestjs/common";
import { NotificationSeverity } from "@prisma/client";
import { NotificationsService } from "../notifications/notifications.service";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Tells a branch that someone's PIN was just switched off after repeated wrong guesses. Fifteen
 * wrong PINs since a password sign-in is rarely a person at the counter, and nobody looks at the
 * audit log unprompted, so this is how guessing at a counter gets noticed.
 */
@Injectable()
export class PinAlerts {
  private readonly logger = new Logger(PinAlerts.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Sent after the refusal has committed; a failure to notify never changes the refusal. */
  async switchedOff(
    tenantId: string,
    branchId: string,
    staffUserId: string,
  ): Promise<void> {
    try {
      // tenant-scope: verified-parent — the membership filter scopes the account to this tenant.
      const person = await this.prisma.appUser.findFirst({
        where: { id: staffUserId, tenantMemberships: { some: { tenantId } } },
        select: { fullName: true },
      });
      const name = person?.fullName ?? "A staff member";
      await this.notifications.notifyCounterAlert(
        tenantId,
        branchId,
        "pin_switched_off",
        {
          severity: NotificationSeverity.warning,
          title: `${name}'s PIN was switched off after repeated wrong PINs`,
          message:
            "It works again once they sign in with their password. If they didn't make these attempts, check who has had access to the counters at this branch.",
          actionLabel: "Open staff",
          actionHref: "/users",
          entityId: staffUserId,
        },
      );
    } catch (error) {
      this.logger.error(
        `PIN switched-off alert failed for user=${staffUserId}`,
        error as Error,
      );
    }
  }
}
