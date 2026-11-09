import { Injectable, NotFoundException } from "@nestjs/common";
import type {
  LocalAttendanceProofReceipt,
  TerminalCounterView,
  TerminalEnrollmentCommand,
  TerminalEnrollmentStatusView,
  TerminalIdentity,
  TerminalSessionCommand,
  WorkSessionIdentity,
} from "@pharmaceylon/shared";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { AccessService } from "../security/access.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { AttendanceProofsService } from "./attendance-proofs.service";
import { buildEnrollmentOfflineBackup } from "./enrollment-status.util";
import { TerminalTrustService } from "./terminal-trust.service";
import { denied, object, parseIdentity, text, uuid } from "./terminal-wire";

/** `{ envelope, attendanceProofId }` — exactly these keys, as the finish routes accept. */
function signedWithProof(raw: unknown) {
  const body = object(raw, ["envelope", "attendanceProofId"]);
  return { envelope: body.envelope, proofId: text(body.attendanceProofId) };
}

/**
 * P2 HTTP surface over P1's `TerminalTrustService`: counters, desktop enrollment and staff
 * sessions. Each call is one transaction; the trust service does every authority, challenge,
 * signature and attendance check. Enrollment and sessions bind no offline grant, nomination or
 * financial shift.
 */
@Injectable()
export class TerminalEnrollmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly trust: TerminalTrustService,
    private readonly attendance: AttendanceProofsService,
    private readonly audit: AuditService,
  ) {}

  async listCounters(
    user: RequestUser,
    branchId: string,
  ): Promise<TerminalCounterView[]> {
    return this.prisma.$transaction(
      async (tx): Promise<TerminalCounterView[]> => {
        const access = await this.access.resolveLive(user, uuid(branchId), tx);
        if (!access.has("tenant.management")) denied("PERMISSION_DENIED");
        const counters = await tx.terminalCounter.findMany({
          where: { tenantId: user.tenantId, branchId },
          orderBy: [{ label: "asc" }, { id: "asc" }],
          include: {
            terminals: {
              where: { retiredAt: null },
              include: {
                enrollments: {
                  where: { revokedAt: null },
                  orderBy: { createdAt: "desc" },
                  take: 1,
                },
              },
            },
          },
        });
        return counters.map((counter) => {
          const terminal = counter.terminals[0] ?? null;
          const enrollment = terminal?.enrollments[0] ?? null;
          return {
            registerId: counter.id,
            tillId: counter.tillId,
            label: counter.label,
            isActive: counter.isActive,
            terminal: terminal
              ? {
                  terminalId: terminal.id,
                  label: terminal.label,
                  enrollmentId: enrollment?.id ?? null,
                  enrolledAt: enrollment?.createdAt.getTime() ?? null,
                }
              : null,
          };
        });
      },
    );
  }

  async createCounter(
    user: RequestUser,
    branchId: string,
    label: string,
  ): Promise<TerminalCounterView> {
    const counter = await this.prisma.$transaction((tx) =>
      this.trust.createCounter(tx, user, branchId, label),
    );
    return {
      registerId: counter.id,
      tillId: counter.tillId,
      label: counter.label,
      isActive: counter.isActive,
      terminal: null,
    };
  }

  beginEnrollment(
    user: RequestUser,
    branchId: string,
    input: {
      registerId: string;
      keyId: string;
      publicKeyHex: string;
      label: string;
    },
  ): Promise<TerminalEnrollmentCommand> {
    return this.prisma.$transaction((tx) =>
      this.trust.beginEnrollment(tx, user, branchId, input),
    );
  }

  finishEnrollment(
    user: RequestUser,
    branchId: string,
    raw: unknown,
  ): Promise<TerminalIdentity> {
    const { envelope, proofId } = signedWithProof(raw);
    return this.prisma.$transaction((tx) =>
      this.trust.finishEnrollment(tx, user, branchId, envelope, proofId),
    );
  }

  /** Lets a desktop learn, at start-up or after an error, whether its enrollment still stands. */
  async enrollmentStatus(
    user: RequestUser,
    branchId: string,
    enrollmentId: string,
  ): Promise<TerminalEnrollmentStatusView> {
    return this.prisma.$transaction(
      async (tx): Promise<TerminalEnrollmentStatusView> => {
        await this.access.resolveLive(user, uuid(branchId), tx);
        const enrollment = await tx.terminalEnrollment.findFirst({
          where: { tenantId: user.tenantId, branchId, id: uuid(enrollmentId) },
          include: { terminal: true },
        });
        if (!enrollment) throw new NotFoundException("Enrollment not found.");
        const terminal = enrollment.terminal;
        let counterLabel: string | null = null;
        if (terminal.registerId !== null && terminal.tillId !== null) {
          const counter = await tx.terminalCounter.findFirst({
            where: {
              tenantId: user.tenantId,
              branchId,
              id: terminal.registerId,
              tillId: terminal.tillId,
            },
            select: { label: true },
          });
          counterLabel = counter?.label ?? null;
        }

        const nomination = await tx.offlineTerminalNomination.findUnique({
          where: { tenantId_branchId: { tenantId: user.tenantId, branchId } },
          select: {
            enrollmentId: true,
            authorizationId: true,
            activatedAt: true,
            activatedByUserId: true,
          },
        });

        const outstandingAuthorization =
          await tx.offlineTerminalAssignmentAuthorization.findFirst({
            where: {
              tenantId: user.tenantId,
              branchId,
              targetEnrollmentId: enrollment.id,
              status: "authorized",
            },
            select: { authorizedAt: true, authorizedByUserId: true },
          });

        const nominationAuthorization = nomination
          ? await tx.offlineTerminalAssignmentAuthorization.findFirst({
              where: {
                tenantId: user.tenantId,
                branchId,
                id: nomination.authorizationId,
              },
              select: { authorizedAt: true, authorizedByUserId: true },
            })
          : null;

        const actorIds = [
          nomination?.activatedByUserId,
          nominationAuthorization?.authorizedByUserId,
          outstandingAuthorization?.authorizedByUserId,
        ].filter((id): id is string => id !== undefined && id !== null);
        const names =
          actorIds.length === 0
            ? new Map<string, string>()
            : new Map(
                (
                  await tx.appUser.findMany({
                    where: { tenantId: user.tenantId, id: { in: [...new Set(actorIds)] } },
                    select: { id: true, fullName: true },
                  })
                ).map((u) => [u.id, u.fullName] as const),
              );
        const fullName = (id: string) => names.get(id) ?? null;

        return {
          enrollmentId: enrollment.id,
          terminalId: enrollment.terminalId,
          registerId: terminal.registerId,
          tillId: terminal.tillId,
          label: terminal.label,
          counterLabel,
          status: terminal.retiredAt ? "retired" : enrollment.revokedAt ? "revoked" : "active",
          offlineBackup: buildEnrollmentOfflineBackup(
            enrollment.id,
            nomination,
            nominationAuthorization,
            outstandingAuthorization,
            fullName,
          ),
        };
      },
    );
  }

  beginSession(
    user: RequestUser,
    branchId: string,
    raw: unknown,
  ): Promise<TerminalSessionCommand> {
    const body = object(raw, ["identity"]);
    const identity = parseIdentity(body.identity);
    return this.prisma.$transaction((tx) =>
      this.trust.beginSession(tx, user, branchId, identity),
    );
  }

  finishSession(
    user: RequestUser,
    branchId: string,
    raw: unknown,
  ): Promise<WorkSessionIdentity> {
    const { envelope, proofId } = signedWithProof(raw);
    return this.prisma.$transaction((tx) =>
      this.trust.finishSession(tx, user, branchId, envelope, proofId),
    );
  }

  async endSession(
    user: RequestUser,
    branchId: string,
    workSessionId: string,
  ): Promise<void> {
    await this.prisma.$transaction((tx) =>
      this.trust.endSession(tx, user, branchId, workSessionId),
    );
  }

  async revokeEnrollment(
    user: RequestUser,
    branchId: string,
    enrollmentId: string,
    reason: string,
  ) {
    await this.prisma.$transaction((tx) =>
      this.trust.revokeEnrollment(tx, user, branchId, enrollmentId, reason),
    );
  }

  async retireTerminal(
    user: RequestUser,
    branchId: string,
    terminalId: string,
    reason: string,
  ) {
    await this.prisma.$transaction((tx) =>
      this.trust.retireTerminal(tx, user, branchId, terminalId, reason),
    );
  }

  /** Go-live evidence (D-W1): the signed-in person confirmed the test receipt printed here. */
  async recordTestReceipt(
    user: RequestUser,
    branchId: string,
    workSessionId: string,
    printerName: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const { identity, session } = await this.trust.requireOpenSession(
        tx,
        user,
        branchId,
        workSessionId,
      );
      const row = await tx.terminalTestReceipt.create({
        data: {
          tenantId: user.tenantId,
          branchId,
          terminalId: identity.terminalId,
          enrollmentId: identity.enrollmentId,
          keyId: identity.keyId,
          workSessionId: session.id,
          confirmedBy: user.userId,
          printerName: text(printerName, 260),
        },
      });
      await this.audit.log(
        {
          tenantId: user.tenantId,
          branchId,
          actorUserId: user.userId,
          eventName: "terminal.test_receipt_confirmed",
          entityName: "terminal_test_receipt",
          entityId: row.id,
          payload: {
            enrollmentId: identity.enrollmentId,
            printerName: row.printerName,
          },
        },
        tx,
      );
      return { testReceiptId: row.id, confirmedAt: row.confirmedAt.getTime() };
    });
  }

  recordAttendance(
    user: RequestUser,
    branchId: string,
    raw: unknown,
  ): Promise<LocalAttendanceProofReceipt> {
    return this.attendance.record(user, branchId, raw);
  }
}
