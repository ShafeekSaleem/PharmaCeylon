import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type {
  TerminalEnrollmentCodeChallenge,
  TerminalEnrollmentCodeIssued,
  TerminalEnrollmentCodeView,
} from "@pharmaceylon/shared";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { AccessService } from "../security/access.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { newEnrollmentCode, TerminalTrustService } from "./terminal-trust.service";
import { denied, sha256, uuid } from "./terminal-wire";

type Tx = Prisma.TransactionClient;
const MANAGE = "tenant.management";
const DEFAULT_MINUTES = 60;

type CodeRow = Prisma.TerminalEnrollmentCodeGetPayload<{ include: { counter: true } }>;

function view(row: CodeRow, now = Date.now()): TerminalEnrollmentCodeView {
  return {
    codeId: row.id,
    registerId: row.registerId,
    tillId: row.tillId,
    counterLabel: row.counter.label,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
    usedAt: row.usedAt?.getTime() ?? null,
    usedByUserId: row.usedByUserId,
    enrollmentId: row.enrollmentId,
    revokedAt: row.revokedAt?.getTime() ?? null,
    status: row.usedAt ? "used" : row.revokedAt ? "revoked" : row.expiresAt.getTime() <= now ? "expired" : "outstanding",
  };
}

/**
 * P2 one-time enrollment codes. A branch manager issues a code for one free counter (from the web
 * Counters screen, W6, or the desktop); whoever is at the new computer enrolls it with their own
 * account by redeeming the code. Only the code's SHA-256 is stored; it is shown once, expires
 * (default 60 minutes, at most 24 hours), is single use and can be revoked.
 */
@Injectable()
export class EnrollmentCodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly trust: TerminalTrustService,
    private readonly audit: AuditService,
  ) {}

  private async manager(tx: Tx, user: RequestUser, branchId: string) {
    const access = await this.access.resolveLive(user, uuid(branchId), tx);
    if (!access.has(MANAGE)) denied("PERMISSION_DENIED");
  }

  list(user: RequestUser, branchId: string): Promise<TerminalEnrollmentCodeView[]> {
    return this.prisma.$transaction(async (tx) => {
      await this.manager(tx, user, branchId);
      const rows = await tx.terminalEnrollmentCode.findMany({
        where: { tenantId: user.tenantId, branchId },
        include: { counter: true },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      return rows.map((row) => view(row));
    });
  }

  issue(
    user: RequestUser,
    branchId: string,
    input: { registerId: string; expiresInMinutes?: number },
  ): Promise<TerminalEnrollmentCodeIssued> {
    return this.prisma.$transaction(async (tx) => {
      await this.manager(tx, user, branchId);
      const counter = await tx.terminalCounter.findFirst({
        where: { tenantId: user.tenantId, branchId, id: uuid(input.registerId), isActive: true },
        include: { terminals: { where: { retiredAt: null }, select: { id: true } } },
      });
      if (!counter) throw new NotFoundException("Counter not found.");
      if (counter.terminals.length)
        throw new ConflictException({
          code: "COUNTER_OCCUPIED",
          message: "A computer is already enrolled on this counter. Retire it first.",
        });
      const minutes = input.expiresInMinutes ?? DEFAULT_MINUTES;
      const { code, display } = newEnrollmentCode();
      const now = new Date();
      const row = await tx.terminalEnrollmentCode.create({
        data: {
          tenantId: user.tenantId,
          branchId,
          registerId: counter.id,
          tillId: counter.tillId,
          codeHash: sha256(code),
          createdByUserId: user.userId,
          createdAt: now,
          expiresAt: new Date(now.getTime() + minutes * 60_000),
        },
        include: { counter: true },
      });
      await this.audit.log(
        {
          tenantId: user.tenantId,
          branchId,
          actorUserId: user.userId,
          eventName: "terminal.enrollment_code_issued",
          entityName: "terminal_enrollment_code",
          entityId: row.id,
          payload: { registerId: counter.id, expiresAt: row.expiresAt.toISOString() },
        },
        tx,
      );
      return { code: display, view: view(row) };
    });
  }

  revoke(user: RequestUser, branchId: string, codeId: string): Promise<TerminalEnrollmentCodeView> {
    return this.prisma.$transaction(async (tx) => {
      await this.manager(tx, user, branchId);
      await tx.$queryRaw`SELECT id FROM terminal_enrollment_code WHERE tenant_id = ${user.tenantId}::uuid
        AND branch_id = ${branchId}::uuid AND id = ${uuid(codeId)}::uuid FOR UPDATE`;
      const row = await tx.terminalEnrollmentCode.findFirst({
        where: { tenantId: user.tenantId, branchId, id: codeId },
        include: { counter: true },
      });
      if (!row) throw new NotFoundException("Enrollment code not found.");
      if (row.usedAt || row.revokedAt) return view(row);
      await tx.terminalEnrollmentCode.updateMany({
        where: { tenantId: user.tenantId, branchId, id: codeId, usedAt: null, revokedAt: null },
        data: { revokedAt: new Date(), revokedByUserId: user.userId },
      });
      await this.audit.log(
        {
          tenantId: user.tenantId,
          branchId,
          actorUserId: user.userId,
          eventName: "terminal.enrollment_code_revoked",
          entityName: "terminal_enrollment_code",
          entityId: codeId,
        },
        tx,
      );
      const updated = await tx.terminalEnrollmentCode.findFirstOrThrow({
        where: { tenantId: user.tenantId, branchId, id: codeId },
        include: { counter: true },
      });
      return view(updated);
    });
  }

  redeemChallenge(
    user: RequestUser,
    branchId: string,
    input: { code: string; keyId: string; publicKeyHex: string; label: string },
  ): Promise<TerminalEnrollmentCodeChallenge> {
    return this.prisma.$transaction((tx) => this.trust.beginEnrollmentWithCode(tx, user, branchId, input));
  }
}
