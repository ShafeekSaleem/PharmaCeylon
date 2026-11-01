import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, RoleName } from "@prisma/client";
import type { OnlineTerminalCommand } from "@pharmaceylon/shared";
import { AuditService } from "../audit/audit.service";
import { businessToday, dateKeyToUtc, safeTimeZone } from "../common/business-date.util";
import { PrismaService } from "../prisma/prisma.service";
import { AccessService } from "../security/access.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { denied, invalid } from "../terminals/terminal-wire";

type Tx = Prisma.TransactionClient;

export const PHARMACIST_REGISTRATION_ERRORS = {
  ownerOnly: "PHARMACIST_REGISTRATION_OWNER_ONLY",
  numberInUse: "SLMC_NUMBER_IN_USE",
} as const;

/** SLMC registration numbers as staff type them, stored upper-case. */
const SLMC_NUMBER = /^[A-Z0-9][A-Z0-9/-]{0,31}$/;
/** A registration further out than this is almost certainly a typo. */
const MAX_YEARS_AHEAD = 10;

export type PharmacistRegistrationStatus = "current" | "expired" | "revoked";

type Row = Prisma.PharmacistRegistrationGetPayload<{
  include: { membership: { select: { user: { select: { fullName: true; email: true } } } } };
}>;

/**
 * P1 #47: who is a qualified pharmacist, as a fact an owner records, not a role.
 *
 * - **Recording.** Only an owner records or revokes a registration: the staff member's SLMC
 *   registration number and the date it expires. A renewal revokes the row it replaces in the
 *   same transaction. Rows are never edited or deleted (database trigger).
 * - **The check.** `assertQualified` needs the staff member's current registration (unrevoked,
 *   not past its expiry in the branch's timezone) and an active account assigned to the branch.
 *   It share-locks the registration, so a revocation either commits first and is seen, or waits
 *   for the clinical transaction. No role or permission stands in for it, an owner's included;
 *   the operation's own permission is checked separately.
 */
@Injectable()
export class PharmacistRegistrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async list(user: RequestUser) {
    const [tenant, rows] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { timezone: true } }),
      this.prisma.pharmacistRegistration.findMany({
        where: { tenantId: user.tenantId },
        include: { membership: { select: { user: { select: { fullName: true, email: true } } } } },
        orderBy: [{ revokedAt: { sort: "desc", nulls: "first" } }, { recordedAt: "desc" }],
        take: 500,
      }),
    ]);
    const today = businessToday(safeTimeZone(tenant?.timezone));
    return rows.map((row) => this.map(row, today));
  }

  async record(user: RequestUser, branchId: string, input: { userId: string; slmcNumber: string; expiresOn: string }) {
    const slmcNumber = input.slmcNumber.trim().toUpperCase();
    if (!SLMC_NUMBER.test(slmcNumber))
      throw new BadRequestException("Enter the SLMC registration number: letters, digits, / or -, up to 32 characters.");
    let expiresOn: Date;
    try {
      expiresOn = dateKeyToUtc(input.expiresOn);
    } catch {
      throw new BadRequestException("Enter the expiry date as YYYY-MM-DD.");
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.requireOwner(tx, user, branchId);
        const target = await tx.$queryRaw<{ id: string }[]>`SELECT m.id FROM tenant_membership m
          JOIN app_user u ON u.id = m.user_id
          WHERE m.tenant_id = ${user.tenantId}::uuid AND m.user_id = ${input.userId}::uuid
            AND m.is_active AND u.is_active
          FOR UPDATE OF m`;
        if (target.length !== 1) throw new NotFoundException("Staff member not found.");
        // Live authority again after the membership lock wait.
        await this.requireOwner(tx, user, branchId);
        const today = await this.tenantToday(tx, user.tenantId);
        if (expiresOn < today) throw new BadRequestException("That registration has already expired.");
        const latest = new Date(today);
        latest.setUTCFullYear(latest.getUTCFullYear() + MAX_YEARS_AHEAD);
        if (expiresOn > latest) throw new BadRequestException("Check the expiry date: it is more than 10 years away.");

        const previous = await tx.pharmacistRegistration.findFirst({
          where: { tenantId: user.tenantId, userId: input.userId, revokedAt: null },
        });
        if (previous && previous.slmcNumber === slmcNumber && previous.expiresOn.getTime() === expiresOn.getTime())
          return this.map(await this.load(tx, user.tenantId, previous.id), today);
        const now = new Date();
        if (previous)
          await tx.pharmacistRegistration.updateMany({
            where: { id: previous.id, tenantId: user.tenantId, revokedAt: null },
            data: { revokedAt: now, revokedByUserId: user.userId, revocationReason: "Replaced by a newer registration" },
          });
        const created = await tx.pharmacistRegistration.create({
          data: { tenantId: user.tenantId, userId: input.userId, slmcNumber, expiresOn, recordedByUserId: user.userId, recordedAt: now },
        });
        await this.audit.log(
          {
            tenantId: user.tenantId,
            branchId,
            actorUserId: user.userId,
            eventName: "pharmacist_registration.recorded",
            entityName: "pharmacist_registration",
            entityId: created.id,
            payload: {
              userId: input.userId,
              slmcNumber,
              expiresOn: input.expiresOn,
              replacesRegistrationId: previous?.id ?? null,
            },
          },
          tx,
        );
        return this.map(await this.load(tx, user.tenantId, created.id), today);
      });
    } catch (error) {
      // The partial unique index on current numbers: someone else holds this registration.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        throw new ConflictException({
          code: PHARMACIST_REGISTRATION_ERRORS.numberInUse,
          message: "Another staff member's current registration has this SLMC number.",
        });
      throw error;
    }
  }

  async revoke(user: RequestUser, branchId: string, registrationId: string, reason: string) {
    const note = reason.trim();
    if (!note) throw new BadRequestException("Say why the registration is being revoked.");
    return this.prisma.$transaction(async (tx) => {
      await this.requireOwner(tx, user, branchId);
      const rows = await tx.$queryRaw<{ id: string; revoked_at: Date | null }[]>`SELECT id, revoked_at
        FROM pharmacist_registration WHERE id = ${registrationId}::uuid AND tenant_id = ${user.tenantId}::uuid
        FOR UPDATE`;
      if (rows.length !== 1) throw new NotFoundException("Registration not found.");
      await this.requireOwner(tx, user, branchId);
      const today = await this.tenantToday(tx, user.tenantId);
      if (rows[0].revoked_at) return this.map(await this.load(tx, user.tenantId, registrationId), today);
      await tx.pharmacistRegistration.updateMany({
        where: { id: registrationId, tenantId: user.tenantId, revokedAt: null },
        data: { revokedAt: new Date(), revokedByUserId: user.userId, revocationReason: note },
      });
      await this.audit.log(
        {
          tenantId: user.tenantId,
          branchId,
          actorUserId: user.userId,
          eventName: "pharmacist_registration.revoked",
          entityName: "pharmacist_registration",
          entityId: registrationId,
          payload: { reason: note },
        },
        tx,
      );
      return this.map(await this.load(tx, user.tenantId, registrationId), today);
    });
  }

  /**
   * Clinical evidence for one staff member at one branch, on the caller's transaction, or
   * `PHARMACIST_REQUIRED`. Returns the registration it relied on, for provenance.
   */
  async assertQualified(tx: Tx, staff: { tenantId: string; branchId: string; userId: string }, at: Date = new Date()) {
    const rows = await tx.$queryRaw<{ id: string; slmc_number: string; expires_on: Date }[]>`SELECT r.id,
        r.slmc_number, r.expires_on
      FROM pharmacist_registration r
      WHERE r.tenant_id = ${staff.tenantId}::uuid AND r.user_id = ${staff.userId}::uuid AND r.revoked_at IS NULL
      FOR SHARE OF r`;
    const registration = rows[0];
    if (!registration) denied("PHARMACIST_REQUIRED");
    // Read after the lock: account, membership and branch assignment as they are now.
    const branch = await tx.branch.findFirst({
      where: { id: staff.branchId, tenantId: staff.tenantId, isActive: true },
      select: { timezone: true },
    });
    const assigned = await tx.userBranchRole.count({
      where: {
        tenantId: staff.tenantId,
        userId: staff.userId,
        branchId: staff.branchId,
        user: { isActive: true, tenantMemberships: { some: { tenantId: staff.tenantId, isActive: true } } },
      },
    });
    if (!branch || assigned === 0) denied("PHARMACIST_REQUIRED");
    if (registration.expires_on < businessToday(safeTimeZone(branch.timezone), at)) denied("PHARMACIST_REQUIRED");
    return { registrationId: registration.id, slmcNumber: registration.slmc_number };
  }

  /** The `MandatoryOperationEvidence.clinical` provider: the signed session's own staff member
   * must be qualified. A co-signing pharmacist (`pharmacistEvidenceId`) is not accepted online
   * yet; that evidence arrives with the desktop dispensing flow. */
  async assertForCommand(tx: Tx, command: OnlineTerminalCommand<unknown>, at: Date = new Date()): Promise<void> {
    if (command.pharmacistEvidenceId !== null) invalid();
    await this.assertQualified(
      tx,
      { tenantId: command.identity.tenantId, branchId: command.identity.branchId, userId: command.session.staffUserId },
      at,
    );
  }

  private async requireOwner(tx: Tx, user: RequestUser, branchId: string) {
    const actor = await this.access.resolveLive(user, branchId, tx);
    if (!actor.roleKeys.includes(RoleName.owner))
      throw new ForbiddenException({
        code: PHARMACIST_REGISTRATION_ERRORS.ownerOnly,
        message: "Only an owner can record or revoke a pharmacist's registration.",
      });
  }

  private async tenantToday(tx: Tx, tenantId: string) {
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
    return businessToday(safeTimeZone(tenant?.timezone));
  }

  private load(tx: Tx, tenantId: string, id: string): Promise<Row> {
    return tx.pharmacistRegistration.findFirstOrThrow({
      where: { id, tenantId },
      include: { membership: { select: { user: { select: { fullName: true, email: true } } } } },
    });
  }

  private map(row: Row, today: Date) {
    const status: PharmacistRegistrationStatus = row.revokedAt ? "revoked" : row.expiresOn < today ? "expired" : "current";
    return {
      id: row.id,
      userId: row.userId,
      fullName: row.membership.user.fullName,
      email: row.membership.user.email,
      slmcNumber: row.slmcNumber,
      expiresOn: row.expiresOn.toISOString().slice(0, 10),
      status,
      recordedByUserId: row.recordedByUserId,
      recordedAt: row.recordedAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
      revokedByUserId: row.revokedByUserId,
      revocationReason: row.revocationReason,
    };
  }
}
