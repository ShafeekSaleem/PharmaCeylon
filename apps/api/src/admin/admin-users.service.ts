import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { RoleName } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AssignBranchRoleDto } from "./dto/assign-branch-role.dto";
import { CreateTenantUserDto } from "./dto/create-tenant-user.dto";

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listUsers(tenantId: string) {
    return this.prisma.appUser.findMany({
      where: { tenantId },
      orderBy: { email: "asc" },
      select: {
        id: true,
        email: true,
        fullName: true,
        isActive: true,
        createdAt: true,
        userBranchRoles: {
          select: { id: true, branchId: true, role: true },
        },
      },
    });
  }

  async createUser(actorTenantId: string, actorUserId: string, dto: CreateTenantUserDto) {
    const email = dto.email.toLowerCase().trim();
    const hash = await bcrypt.hash(dto.password, 10);
    try {
      const user = await this.prisma.appUser.create({
        data: {
          tenantId: actorTenantId,
          email,
          fullName: dto.fullName.trim(),
          passwordHash: hash,
        },
        select: {
          id: true,
          email: true,
          fullName: true,
          isActive: true,
          createdAt: true,
          userBranchRoles: true,
        },
      });
      await this.audit.log({
        tenantId: actorTenantId,
        actorUserId: actorUserId,
        eventName: "user.created",
        entityName: "app_user",
        entityId: user.id,
        payload: { email: user.email },
      });
      return user;
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code === "P2002") {
        throw new ConflictException("Email is already registered");
      }
      throw e;
    }
  }

  async assignBranchRole(
    tenantId: string,
    actorUserId: string,
    targetUserId: string,
    dto: AssignBranchRoleDto,
  ) {
    const target = await this.prisma.appUser.findFirst({
      where: { id: targetUserId, tenantId },
    });
    if (!target) throw new NotFoundException("User not found");

    const branch = await this.prisma.branch.findFirst({
      where: { id: dto.branchId, tenantId },
    });
    if (!branch) throw new NotFoundException("Branch not found");

    const row = await this.prisma.userBranchRole.upsert({
      where: {
        tenantId_userId_branchId_role: {
          tenantId,
          userId: targetUserId,
          branchId: dto.branchId,
          role: dto.role,
        },
      },
      create: {
        tenantId,
        userId: targetUserId,
        branchId: dto.branchId,
        role: dto.role,
      },
      update: {},
    });
    await this.audit.log({
      tenantId,
      actorUserId,
      eventName: "user.branch_role.assigned",
      entityName: "user_branch_role",
      entityId: row.id,
      payload: { targetUserId, branchId: dto.branchId, role: dto.role },
    });
    return row;
  }

  async removeBranchRole(
    tenantId: string,
    actorUserId: string,
    targetUserId: string,
    mappingId: string,
  ) {
    const row = await this.prisma.userBranchRole.findFirst({
      where: { id: mappingId, tenantId, userId: targetUserId },
    });
    if (!row) throw new NotFoundException("Role mapping not found");
    if (row.role === RoleName.owner && targetUserId === actorUserId) {
      throw new ForbiddenException("Cannot remove your own owner role mapping");
    }
    await this.prisma.userBranchRole.delete({ where: { id: mappingId } });
    await this.audit.log({
      tenantId,
      actorUserId,
      eventName: "user.branch_role.removed",
      entityName: "user_branch_role",
      entityId: mappingId,
      payload: { targetUserId },
    });
    return { ok: true };
  }
}
