import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  defaultCounterPolicy,
  validateCounterPolicy,
  type CounterPolicyView,
} from "@pharmaceylon/shared";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { AccessService } from "../security/access.service";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { UpdateCounterPolicyDto } from "./dto/counter-policy.dto";

const select = {
  id: true,
  name: true,
  counterPolicy: true,
  counterPolicyVersion: true,
} satisfies Prisma.BranchSelect;

@Injectable()
export class CounterPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async get(user: RequestUser, branchId: string): Promise<CounterPolicyView> {
    const branch = await this.find(user.tenantId, branchId);
    const actor = await this.access.resolve(user, branchId);
    if (!actor.has("tenant.management"))
      throw new ForbiddenException(
        "Counter settings require settings access at this branch.",
      );
    const parsed = validateCounterPolicy(
      branch.counterPolicy ?? defaultCounterPolicy(),
    );
    if (!parsed.ok)
      throw new ServiceUnavailableException(
        "The saved counter policy needs repair before it can be used.",
      );
    return {
      branchId,
      branchName: branch.name,
      version: branch.counterPolicyVersion,
      policy: parsed.value,
      canEdit: true,
    };
  }

  async update(
    user: RequestUser,
    branchId: string,
    dto: UpdateCounterPolicyDto,
  ): Promise<CounterPolicyView> {
    const parsed = validateCounterPolicy(dto.policy);
    if (!parsed.ok) throw new BadRequestException(parsed.message);
    await this.find(user.tenantId, branchId);
    await this.prisma.$transaction(async (tx) => {
      // Check both before and after the branch row lock. A removed grant during a lock wait
      // must not authorize this edit. Effects and the audit either both commit or both roll back.
      const before = await this.writeAuthority(user, branchId, tx);
      if (!before.has("tenant.management"))
        throw new ForbiddenException(
          "Counter settings require settings access at this branch.",
        );
      const saved = await tx.branch.updateMany({
        where: {
          id: branchId,
          tenantId: user.tenantId,
          isActive: true,
          counterPolicyVersion: dto.expectedVersion,
        },
        data: {
          counterPolicy: parsed.value as unknown as Prisma.InputJsonValue,
          counterPolicyVersion: { increment: 1 },
        },
      });
      if (saved.count !== 1)
        throw new ConflictException(
          "Counter settings changed. Reload them before saving again.",
        );
      const current = await this.writeAuthority(user, branchId, tx);
      if (!current.has("tenant.management"))
        throw new ForbiddenException("Counter settings access was removed.");
      await this.audit.log(
        {
          tenantId: user.tenantId,
          branchId,
          actorUserId: user.userId,
          eventName: "branch.counter_policy_updated",
          entityName: "branch",
          entityId: branchId,
          payload: {
            fromVersion: dto.expectedVersion,
            toVersion: dto.expectedVersion + 1,
            policy: parsed.value,
          } as unknown as Prisma.InputJsonValue,
        },
        tx,
      );
    });
    return this.get(user, branchId);
  }

  private async find(tenantId: string, branchId: string) {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, tenantId, isActive: true },
      select,
    });
    if (!branch) throw new NotFoundException("Branch not found.");
    return branch;
  }

  private async writeAuthority(
    user: RequestUser,
    branchId: string,
    tx: Prisma.TransactionClient,
  ) {
    // Owners may manage all branches, including branches where they have no staff assignment.
    // Resolve the owner role live at its actual branch; a stale owner claim grants nothing.
    const ownerBranch = user.branchRoles.find(
      (role) => role.role === "owner",
    )?.branchId;
    const scope = ownerBranch ?? branchId;
    const actor = await this.access.resolveLive(user, scope, tx);
    if (scope !== branchId && !actor.roleKeys.includes("owner"))
      throw new ForbiddenException("No current authority over this branch.");
    return actor;
  }
}
