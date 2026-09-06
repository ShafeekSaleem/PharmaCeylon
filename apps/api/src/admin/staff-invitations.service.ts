import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { RoleName } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { createHash, randomBytes } from "node:crypto";
import { AuditService } from "../audit/audit.service";
import { AuthService, RequestMeta } from "../auth/auth.service";
import { VerificationEmailService } from "../auth/verification-email.service";
import { PrismaService } from "../prisma/prisma.service";
import { AcceptStaffInvitationDto } from "./dto/accept-staff-invitation.dto";
import {
  CreateStaffInvitationDto,
  StaffInvitationAssignmentDto,
} from "./dto/create-staff-invitation.dto";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class StaffInvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: VerificationEmailService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string) {
    return this.prisma.staffInvitation.findMany({
      where: { tenantId, acceptedAt: null, revokedAt: null },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        fullName: true,
        expiresAt: true,
        createdAt: true,
        roles: {
          select: {
            branchId: true,
            role: true,
            roleId: true,
            branch: { select: { name: true, code: true } },
            roleRef: { select: { name: true } },
          },
        },
      },
    });
  }

  async create(
    tenantId: string,
    actorUserId: string,
    actorIsOwner: boolean,
    dto: CreateStaffInvitationDto,
  ) {
    const email = dto.email.trim().toLowerCase();
    const fullName = dto.fullName.trim();
    if (!fullName) throw new BadRequestException("Full name is required");
    const assignments = await this.validateAssignments(
      tenantId,
      actorIsOwner,
      dto.assignments,
    );
    const existingMember = await this.prisma.tenantMembership.findFirst({
      where: { tenantId, isActive: true, user: { email } },
    });
    if (existingMember) {
      throw new ConflictException("This person already belongs to the pharmacy");
    }
    const pending = await this.prisma.staffInvitation.findFirst({
      where: { tenantId, email, acceptedAt: null, revokedAt: null },
    });
    if (pending) {
      throw new ConflictException("A pending invitation already exists for this email");
    }

    const rawToken = randomBytes(32).toString("base64url");
    const invitation = await this.prisma.staffInvitation.create({
      data: {
        tenantId,
        email,
        fullName,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        invitedByUserId: actorUserId,
        roles: { create: assignments.map((entry) => ({ tenantId, ...entry })) },
      },
      include: {
        tenant: { select: { displayName: true } },
        invitedBy: { select: { fullName: true } },
      },
    });
    await this.send(invitation, rawToken);
    await this.audit.log({
      tenantId,
      actorUserId,
      eventName: "staff.invitation.sent",
      entityName: "staff_invitation",
      entityId: invitation.id,
      payload: { email, assignments: assignments.length },
    });
    return { id: invitation.id, email, fullName, expiresAt: invitation.expiresAt };
  }

  async resend(tenantId: string, actorUserId: string, invitationId: string) {
    const rawToken = randomBytes(32).toString("base64url");
    const invitation = await this.prisma.staffInvitation.update({
      where: { id: invitationId, tenantId, acceptedAt: null, revokedAt: null },
      data: {
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      },
      include: {
        tenant: { select: { displayName: true } },
        invitedBy: { select: { fullName: true } },
      },
    }).catch(() => null);
    if (!invitation) throw new NotFoundException("Pending invitation not found");
    await this.send(invitation, rawToken);
    await this.audit.log({
      tenantId,
      actorUserId,
      eventName: "staff.invitation.resent",
      entityName: "staff_invitation",
      entityId: invitation.id,
    });
    return { ok: true, expiresAt: invitation.expiresAt };
  }

  async revoke(tenantId: string, actorUserId: string, invitationId: string) {
    const result = await this.prisma.staffInvitation.updateMany({
      where: { id: invitationId, tenantId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException("Pending invitation not found");
    await this.audit.log({
      tenantId,
      actorUserId,
      eventName: "staff.invitation.revoked",
      entityName: "staff_invitation",
      entityId: invitationId,
    });
    return { ok: true };
  }

  async inspect(token: string) {
    const invitation = await this.findUsable(token);
    const accountExists = Boolean(
      await this.prisma.appUser.findUnique({ where: { email: invitation.email } }),
    );
    return {
      email: invitation.email,
      fullName: invitation.fullName,
      pharmacyName: invitation.tenant.displayName,
      invitedByName: invitation.invitedBy.fullName,
      expiresAt: invitation.expiresAt,
      accountExists,
      assignments: invitation.roles.map((entry) => ({
        branchName: entry.branch.name,
        roleName: entry.roleRef?.name ?? titleCase(entry.role),
      })),
    };
  }

  async accept(token: string, dto: AcceptStaffInvitationDto, meta: RequestMeta = {}) {
    const invitation = await this.findUsable(token);
    const existing = await this.prisma.appUser.findUnique({
      where: { email: invitation.email },
    });
    if (existing && !existing.isActive) {
      throw new ForbiddenException(
        "This account is suspended. Ask an administrator to reactivate it first",
      );
    }
    if (existing && !(await bcrypt.compare(dto.password, existing.passwordHash))) {
      throw new UnauthorizedException("The password for this account is incorrect");
    }
    const fullName = (dto.fullName ?? invitation.fullName).trim();
    if (!existing && !fullName) throw new BadRequestException("Full name is required");
    if (!existing && (!/\d/.test(dto.password) || !/[^A-Za-z0-9]/.test(dto.password))) {
      throw new BadRequestException(
        "Use at least 8 characters, including a number and a symbol",
      );
    }
    const passwordHash = existing ? null : await bcrypt.hash(dto.password, 10);

    const userId = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.staffInvitation.updateMany({
        where: {
          id: invitation.id,
          tenantId: invitation.tenantId,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { acceptedAt: new Date() },
      });
      if (claimed.count === 0) throw new ConflictException("This invitation is no longer available");

      const user = existing ?? await tx.appUser.create({
        data: {
          tenantId: invitation.tenantId,
          lastTenantId: invitation.tenantId,
          email: invitation.email,
          fullName,
          passwordHash: passwordHash!,
        },
      });
      await tx.tenantMembership.upsert({
        where: { tenantId_userId: { tenantId: invitation.tenantId, userId: user.id } },
        create: { tenantId: invitation.tenantId, userId: user.id },
        update: { isActive: true },
      });
      // tenant-scope: verified-parent — this invitation established the tenant membership.
      await tx.appUser.update({
        where: { id: user.id },
        data: { lastTenantId: invitation.tenantId },
      });
      for (const role of invitation.roles) {
        await tx.userBranchRole.upsert({
          where: {
            tenantId_userId_branchId_role: {
              tenantId: invitation.tenantId,
              userId: user.id,
              branchId: role.branchId,
              role: role.role,
            },
          },
          create: {
            tenantId: invitation.tenantId,
            userId: user.id,
            branchId: role.branchId,
            role: role.role,
            roleId: role.roleId,
          },
          update: { roleId: role.roleId },
        });
      }
      await tx.staffInvitation.update({
        where: { id: invitation.id, tenantId: invitation.tenantId },
        data: { acceptedUserId: user.id },
      });
      await tx.notificationPreference.upsert({
        where: { tenantId_userId: { tenantId: invitation.tenantId, userId: user.id } },
        create: { tenantId: invitation.tenantId, userId: user.id },
        update: {},
      });
      return user.id;
    });

    await this.audit.log({
      tenantId: invitation.tenantId,
      actorUserId: userId,
      eventName: "staff.invitation.accepted",
      entityName: "staff_invitation",
      entityId: invitation.id,
      payload: { email: invitation.email },
    });
    return this.auth.issueTenantSession(userId, invitation.tenantId, meta);
  }

  private async findUsable(token: string) {
    if (!token || token.length < 20) throw new NotFoundException("Invitation not found");
    const invitation = await this.prisma.staffInvitation.findUnique({
      where: { tokenHash: hashToken(token) },
      include: {
        tenant: { select: { displayName: true, isActive: true } },
        invitedBy: { select: { fullName: true } },
        roles: {
          include: {
            branch: { select: { name: true, isActive: true } },
            roleRef: { select: { name: true } },
          },
        },
      },
    });
    if (
      !invitation ||
      invitation.acceptedAt ||
      invitation.revokedAt ||
      invitation.expiresAt <= new Date() ||
      !invitation.tenant.isActive ||
      invitation.roles.some((entry) => !entry.branch.isActive)
    ) {
      throw new NotFoundException("This invitation is invalid or has expired");
    }
    return invitation;
  }

  private async validateAssignments(
    tenantId: string,
    actorIsOwner: boolean,
    assignments: StaffInvitationAssignmentDto[],
  ) {
    if (assignments.some((entry) => entry.role === RoleName.owner) && !actorIsOwner) {
      throw new ForbiddenException("Only an owner can invite another owner");
    }
    const unique = new Map<string, StaffInvitationAssignmentDto>();
    for (const entry of assignments) unique.set(`${entry.branchId}:${entry.role}`, entry);
    const rows = [...unique.values()];
    const branchIds = [...new Set(rows.map((entry) => entry.branchId))];
    const branches = await this.prisma.branch.findMany({
      where: { tenantId, isActive: true, id: { in: branchIds } },
      select: { id: true },
    });
    if (branches.length !== branchIds.length) throw new NotFoundException("Branch not found");

    const output: Array<{ branchId: string; role: RoleName; roleId: string | null }> = [];
    for (const entry of rows) {
      let roleId: string | null;
      if (entry.role === RoleName.custom) {
        if (!entry.roleId) throw new BadRequestException("roleId is required for a custom role");
        const role = await this.prisma.role.findFirst({
          where: { id: entry.roleId, tenantId, isSystem: false },
        });
        if (!role) throw new NotFoundException("Role not found");
        roleId = role.id;
      } else {
        const role = await this.prisma.role.findUnique({
          where: { tenantId_key: { tenantId, key: entry.role } },
        });
        roleId = role?.id ?? null;
      }
      output.push({ branchId: entry.branchId, role: entry.role, roleId });
    }
    return output;
  }

  private send(
    invitation: {
      email: string;
      fullName: string;
      tenant: { displayName: string };
      invitedBy: { fullName: string };
    },
    token: string,
  ) {
    return this.email.sendStaffInvitation({
      email: invitation.email,
      fullName: invitation.fullName,
      pharmacyName: invitation.tenant.displayName,
      invitedByName: invitation.invitedBy.fullName,
      token,
    });
  }
}

function hashToken(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function titleCase(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}
