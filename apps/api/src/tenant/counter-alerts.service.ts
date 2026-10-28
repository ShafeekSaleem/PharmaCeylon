import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma, RoleName } from "@prisma/client";
import {
  defaultCounterAlertPolicy,
  parseStoredCounterAlertPolicy,
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
    const policy = stored(row.counterAlertPolicy);
    // Deleting a role is the owner's decision in Users & Roles, and a deleted role can't receive
    // anything, so it is dropped here rather than vetoing the deletion. An alert left with no
    // recipient is flagged; the strict save refuses it until someone is chosen or it is off.
    const existing = await this.existingRoleKeys(
      tenantId,
      policy.rules.flatMap((rule) => rule.recipientRoleKeys),
      this.prisma,
    );
    const rules = policy.rules.map((rule) => ({
      ...rule,
      recipientRoleKeys: rule.recipientRoleKeys.filter((key) => existing.has(key)),
    }));
    return {
      version: row.counterAlertPolicyVersion,
      policy: { ...policy, rules },
      unreachableTypes: rules
        .filter((rule) => rule.enabled && rule.recipientRoleKeys.length === 0)
        .map((rule) => rule.type),
    };
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

  /** Recipients are role keys: built-in names, or this tenant's custom role slugs. Only reached
   * when a role is deleted between loading the page and saving it. */
  private async assertRolesExist(
    tenantId: string,
    policy: CounterAlertPolicy,
    tx: Prisma.TransactionClient,
  ) {
    const keys = policy.rules.flatMap((rule) => rule.recipientRoleKeys);
    const existing = await this.existingRoleKeys(tenantId, keys, tx);
    const missing = [...new Set(keys)].filter((key) => !existing.has(key)).sort();
    if (missing.length > 0)
      throw new BadRequestException(
        `${missing.map((key) => `"${key}"`).join(", ")} ${missing.length === 1 ? "is no longer a role" : "are no longer roles"}. Remove ${missing.length === 1 ? "it" : "them"} from the recipients and save again.`,
      );
  }

  private async existingRoleKeys(
    tenantId: string,
    keys: string[],
    db: Prisma.TransactionClient,
  ): Promise<Set<string>> {
    const custom = [...new Set(keys)].filter((key) => !BUILT_IN_ROLE_KEYS.has(key));
    const found = custom.length
      ? await db.role.findMany({ where: { tenantId, key: { in: custom } }, select: { key: true } })
      : [];
    return new Set([...BUILT_IN_ROLE_KEYS, ...found.map((role) => role.key)]);
  }
}

function stored(raw: Prisma.JsonValue | null): CounterAlertPolicy {
  const parsed = parseStoredCounterAlertPolicy(raw ?? defaultCounterAlertPolicy());
  if (!parsed.ok)
    throw new ServiceUnavailableException("The saved counter alert settings need repair.");
  return parsed.value;
}
