import { ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import type { TerminalStaffCredentialView } from "@pharmaceylon/shared";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { TerminalTrustService } from "./terminal-trust.service";

const PIN = /^\d{4,8}$/;
// Same policy as counter co-sign, on the same counters: one PIN, one lockout.
const MAX_PIN_FAILURES = 5;
const PIN_LOCK_MINUTES = 15;

type Tx = Parameters<Parameters<PrismaService["$transaction"]>[0]>[0];

/**
 * D-W5 personal PINs at the counter. Each person has one PIN, set or changed only at an enrolled
 * counter (their own open staff session there) with their login password. The server keeps the
 * bcrypt verifier for online co-sign; each counter keeps its own local verifier, made when the
 * person enters the PIN there while online ("preparing" that counter). A change bumps
 * `posPinVersion`, so every older preparation is stale until the person signs in again.
 * PINs are never logged, stored in plain text or echoed back.
 */
@Injectable()
export class StaffCredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trust: TerminalTrustService,
    private readonly audit: AuditService,
  ) {}

  credential(user: RequestUser, branchId: string, workSessionId: string): Promise<TerminalStaffCredentialView> {
    return this.prisma.$transaction(async (tx) => {
      const { identity } = await this.trust.requireOpenSession(tx, user, branchId, workSessionId);
      return this.view(tx, user, identity.enrollmentId);
    });
  }

  async setPin(
    user: RequestUser,
    branchId: string,
    workSessionId: string,
    input: { pin: string; password: string },
  ): Promise<TerminalStaffCredentialView> {
    if (!PIN.test(input.pin)) throw new ForbiddenException({ code: "PIN_FORMAT", message: "A PIN is 4 to 8 digits." });
    const passwordWrong = await this.prisma.$transaction(async (tx) => {
      const { identity, enrollment } = await this.trust.requireOpenSession(tx, user, branchId, workSessionId);
      const account = await this.account(tx, user);
      if (!(await bcrypt.compare(input.password, account.passwordHash))) return true;
      const posPinHash = await bcrypt.hash(input.pin, 10);
      // tenant-scope: verified-parent — the caller's open session and live branch access were verified above.
      const updated = await tx.appUser.update({
        where: { id: user.userId },
        data: { posPinHash, failedPosPinAttempts: 0, posPinLockedUntil: null, posPinVersion: { increment: 1 } },
        select: { posPinVersion: true },
      });
      // Setting it here proves it here: this counter is prepared at the new version.
      await this.markPrepared(tx, user, identity, enrollment.keyId, updated.posPinVersion);
      await this.audit.log(
        {
          tenantId: user.tenantId,
          branchId,
          actorUserId: user.userId,
          eventName: "user.pos_pin.set",
          entityName: "app_user",
          entityId: user.userId,
          payload: { enrollmentId: identity.enrollmentId, pinVersion: updated.posPinVersion, via: "counter" },
        },
        tx,
      );
      return false;
    });
    if (passwordWrong) throw new UnauthorizedException({ code: "PASSWORD_INCORRECT", message: "Login password is incorrect." });
    return this.credential(user, branchId, workSessionId);
  }

  /** Checks the PIN against the server verifier and records this counter as prepared. */
  async prepare(
    user: RequestUser,
    branchId: string,
    workSessionId: string,
    pin: string,
  ): Promise<TerminalStaffCredentialView> {
    if (!PIN.test(pin)) throw new ForbiddenException({ code: "PIN_FORMAT", message: "A PIN is 4 to 8 digits." });
    const outcome = await this.prisma.$transaction(async (tx) => {
      const { identity, enrollment } = await this.trust.requireOpenSession(tx, user, branchId, workSessionId);
      const account = await this.account(tx, user);
      const now = new Date();
      if (!account.posPinHash) return "not_set" as const;
      if (account.posPinLockedUntil && account.posPinLockedUntil > now) return "locked" as const;
      if (!(await bcrypt.compare(pin, account.posPinHash))) {
        const failures = account.failedPosPinAttempts + 1;
        // tenant-scope: verified-parent — the caller's open session and live branch access were verified above.
        await tx.appUser.update({
          where: { id: user.userId },
          data: {
            failedPosPinAttempts: failures >= MAX_PIN_FAILURES ? 0 : failures,
            posPinLockedUntil:
              failures >= MAX_PIN_FAILURES ? new Date(now.getTime() + PIN_LOCK_MINUTES * 60_000) : undefined,
          },
        });
        return "wrong" as const;
      }
      // tenant-scope: verified-parent — the caller's open session and live branch access were verified above.
      await tx.appUser.update({ where: { id: user.userId }, data: { failedPosPinAttempts: 0 } });
      await this.markPrepared(tx, user, identity, enrollment.keyId, account.posPinVersion);
      return "prepared" as const;
    });
    if (outcome === "not_set")
      throw new ForbiddenException({ code: "PIN_NOT_SET", message: "Set your PIN first." });
    if (outcome === "locked")
      throw new ForbiddenException({ code: "PIN_LOCKED", message: "Too many wrong PINs. Try again later." });
    if (outcome === "wrong") throw new UnauthorizedException({ code: "PIN_INCORRECT", message: "That PIN is not right." });
    return this.credential(user, branchId, workSessionId);
  }

  private async account(tx: Tx, user: RequestUser) {
    // tenant-scope: verified-parent — the caller's open session and live branch access were verified above.
    const account = await tx.appUser.findFirst({
      where: { id: user.userId, isActive: true, tenantMemberships: { some: { tenantId: user.tenantId, isActive: true } } },
      select: {
        passwordHash: true,
        posPinHash: true,
        posPinVersion: true,
        failedPosPinAttempts: true,
        posPinLockedUntil: true,
      },
    });
    if (!account) throw new UnauthorizedException("User not found");
    return account;
  }

  private async markPrepared(
    tx: Tx,
    user: RequestUser,
    identity: { branchId: string; terminalId: string; enrollmentId: string },
    keyId: string,
    pinVersion: number,
  ) {
    await tx.terminalStaffPreparation.upsert({
      where: {
        tenantId_enrollmentId_staffUserId: {
          tenantId: user.tenantId,
          enrollmentId: identity.enrollmentId,
          staffUserId: user.userId,
        },
      },
      create: {
        tenantId: user.tenantId,
        branchId: identity.branchId,
        terminalId: identity.terminalId,
        enrollmentId: identity.enrollmentId,
        keyId,
        staffUserId: user.userId,
        pinVersion,
      },
      update: { pinVersion, preparedAt: new Date() },
    });
    await this.audit.log(
      {
        tenantId: user.tenantId,
        branchId: identity.branchId,
        actorUserId: user.userId,
        eventName: "terminal.staff_prepared",
        entityName: "terminal_enrollment",
        entityId: identity.enrollmentId,
        payload: { pinVersion },
      },
      tx,
    );
  }

  private async view(tx: Tx, user: RequestUser, enrollmentId: string): Promise<TerminalStaffCredentialView> {
    const account = await this.account(tx, user);
    const preparation = await tx.terminalStaffPreparation.findFirst({
      where: { tenantId: user.tenantId, enrollmentId, staffUserId: user.userId },
    });
    const now = Date.now();
    return {
      pinSet: Boolean(account.posPinHash),
      pinVersion: account.posPinVersion,
      lockedUntil:
        account.posPinLockedUntil && account.posPinLockedUntil.getTime() > now ? account.posPinLockedUntil.getTime() : null,
      preparedVersion: preparation?.pinVersion ?? null,
    };
  }
}
