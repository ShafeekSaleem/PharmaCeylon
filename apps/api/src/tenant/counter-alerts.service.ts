import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma, RoleName } from "@prisma/client";
import {
  defaultCounterAlertPolicy,
  validateCounterAlertPolicy,
  type CounterAlertPolicy,
  type CounterAlertPolicyView,
} from "@pharmaceylon/shared";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { UpdateCounterAlertsDto } from "./dto/counter-alerts.dto";

const BUILT_IN_ROLE_KEYS = new Set<string>(
  Object.values(RoleName).filter((role) => role !== RoleName.custom),
);

/**
 * W7: which counter alerts are sent and to which roles. Tenant-wide, versioned and audited like
 * the branch counter policy. Settings only — W9 #71 generates and delivers the alerts.
 */
@Injectable()
export class CounterAlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(tenantId: string): Promise<CounterAlertPolicyView> {
    const row = await this.prisma.tenantSettings.upsert({
      where: { tenantId },
      create: { tenantId },
      update: {},
      select: { counterAlertPolicy: true, counterAlertPolicyVersion: true },
    });
    return { version: row.counterAlertPolicyVersion, policy: stored(row.counterAlertPolicy) };
  }

  async update(user: RequestUser, dto: UpdateCounterAlertsDto): Promise<CounterAlertPolicyView> {
    const parsed = validateCounterAlertPolicy(dto.policy);
    if (!parsed.ok) throw new BadRequestException(parsed.message);
    const settings = await this.prisma.tenantSettings.upsert({
      where: { tenantId: user.tenantId },
      create: { tenantId: user.tenantId },
      update: {},
      select: { id: true },
    });
    await this.prisma.$transaction(async (tx) => {
      await this.assertRolesExist(user.tenantId, parsed.value, tx);
      const saved = await tx.tenantSettings.updateMany({
        where: { tenantId: user.tenantId, counterAlertPolicyVersion: dto.expectedVersion },
        data: {
          counterAlertPolicy: parsed.value as unknown as Prisma.InputJsonValue,
          counterAlertPolicyVersion: { increment: 1 },
        },
      });
      if (saved.count !== 1)
        throw new ConflictException("Counter alert settings changed. Reload them before saving again.");
      await this.audit.log(
        {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          eventName: "tenant_settings.counter_alerts_updated",
          entityName: "tenant_settings",
          entityId: settings.id,
          payload: {
            fromVersion: dto.expectedVersion,
            toVersion: dto.expectedVersion + 1,
            policy: parsed.value,
          } as unknown as Prisma.InputJsonValue,
        },
        tx,
      );
    });
    return this.get(user.tenantId);
  }

  /** Recipients are role keys: built-in names, or this tenant's custom role slugs. */
  private async assertRolesExist(
    tenantId: string,
    policy: CounterAlertPolicy,
    tx: Prisma.TransactionClient,
  ) {
    const keys = [...new Set(policy.rules.flatMap((rule) => rule.recipientRoleKeys))].filter(
      (key) => !BUILT_IN_ROLE_KEYS.has(key),
    );
    if (keys.length === 0) return;
    const found = await tx.role.findMany({
      where: { tenantId, key: { in: keys } },
      select: { key: true },
    });
    if (found.length !== keys.length)
      throw new BadRequestException("A recipient role no longer exists. Reload and try again.");
  }
}

function stored(raw: Prisma.JsonValue | null): CounterAlertPolicy {
  const parsed = validateCounterAlertPolicy(raw ?? defaultCounterAlertPolicy());
  if (!parsed.ok)
    throw new ServiceUnavailableException("The saved counter alert settings need repair.");
  return parsed.value;
}
