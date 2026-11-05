import { ForbiddenException, Injectable } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { IDEMPOTENCY_SCOPE } from "../common/idempotency.constants";
import { normalizeIdempotencyKey } from "../common/idempotency.util";
import { PrismaService } from "../prisma/prisma.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { TerminalTrustService } from "../terminals/terminal-trust.service";
import { CHECKOUT_SEALED_SCOPE, lockCheckoutKey } from "./checkout-lock";
import { SALE_INCLUDE } from "./sale-read.service";

export type CheckoutResolution =
  | { outcome: "landed"; sale: unknown }
  | { outcome: "never_landed" };

class Landed extends Error {
  constructor(readonly saleId: string) {
    super("checkout landed");
  }
}

const otherCounter = () =>
  new ForbiddenException({
    code: "CHECKOUT_OTHER_COUNTER",
    message: "That sale was not rung up at this counter.",
  });

/**
 * P2: someone signed in at an enrolled counter finds out whether an earlier checkout from the same
 * counter landed, when the person who rang it up isn't there to resend it. It never sends the
 * sale: it looks the original up by tenant, branch, enrollment and key, under the seller's own
 * idempotency scope, and answers with the sale as it was committed, attributed to its seller.
 *
 * "Never landed" is only said once it is true for good. The lookup waits on the same lock checkout
 * takes for that key, so an original still running finishes first; and when nothing is there it
 * seals the key, so an original still on its way is refused when it arrives.
 */
@Injectable()
export class CheckoutResolutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly terminalTrust: TerminalTrustService,
    private readonly audit: AuditService,
  ) {}

  async resolve(
    user: RequestUser,
    branchId: string,
    workSessionId: string,
    original: { idempotencyKey: string; workSessionId: string },
  ): Promise<CheckoutResolution> {
    const tenantId = user.tenantId;
    const idempotencyKey = normalizeIdempotencyKey(original.idempotencyKey);
    if (!idempotencyKey) throw otherCounter();

    const result = await this.prisma.$transaction(async (tx) => {
      // Who rang it up. Session rows never change hands, so a plain read is enough to pick the
      // lock; the enrollment is compared once the caller's own session is locked below.
      const first = await tx.terminalStaffSession.findFirst({
        where: { tenantId, branchId, id: original.workSessionId },
        select: { id: true, staffUserId: true, enrollmentId: true },
      });
      if (!first) throw otherCounter();
      // The checkout's own order: key lock first, then the counter's enrollment lock.
      await lockCheckoutKey(tx, tenantId, first.staffUserId, idempotencyKey);
      const { identity } = await this.terminalTrust.requireOpenSession(tx, user, branchId, workSessionId);
      if (first.enrollmentId !== identity.enrollmentId) throw otherCounter();

      const committed = await tx.idempotencyRecord.findUnique({
        where: {
          tenantId_userId_scope_idempotencyKey: {
            tenantId,
            userId: first.staffUserId,
            scope: IDEMPOTENCY_SCOPE.checkout,
            idempotencyKey,
          },
        },
      });
      if (committed) {
        const sale = await tx.sale.findFirst({
          where: { id: committed.resourceId, tenantId, branchId, workSessionId: first.id },
          select: { id: true },
        });
        // The seller used this key for a sale somewhere else: not this counter's to confirm.
        if (!sale) throw otherCounter();
        return new Landed(sale.id);
      }

      const seal = {
        tenantId,
        userId: first.staffUserId,
        scope: CHECKOUT_SEALED_SCOPE,
        idempotencyKey,
      };
      const sealed = await tx.idempotencyRecord.findUnique({
        where: { tenantId_userId_scope_idempotencyKey: seal },
      });
      if (!sealed) await tx.idempotencyRecord.create({ data: { ...seal, resourceId: workSessionId } });
      return { sellerId: first.staffUserId, alreadySealed: Boolean(sealed) };
    });

    if (result instanceof Landed) {
      const sale = await this.prisma.sale.findFirst({
        where: { id: result.saleId, tenantId, branchId },
        include: SALE_INCLUDE,
      });
      await this.audit.log({
        tenantId,
        branchId,
        actorUserId: user.userId,
        eventName: "sale.checkout_resolved",
        entityName: "sale",
        entityId: result.saleId,
        payload: { outcome: "landed", originalWorkSessionId: original.workSessionId, workSessionId },
      });
      return { outcome: "landed", sale };
    }
    if (!result.alreadySealed)
      await this.audit.log({
        tenantId,
        branchId,
        actorUserId: user.userId,
        eventName: "sale.checkout_resolved",
        entityName: "terminal_staff_session",
        entityId: original.workSessionId,
        payload: {
          outcome: "never_landed",
          soldBy: result.sellerId,
          idempotencyKey,
          workSessionId,
        },
      });
    return { outcome: "never_landed" };
  }
}
