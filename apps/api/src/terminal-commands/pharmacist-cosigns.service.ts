import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { PharmacistCosign } from "@pharmaceylon/shared";
import { isCosignable, PharmacistCosignService } from "../clinical/pharmacist-cosign.service";
import { PrismaService } from "../prisma/prisma.service";
import { tenantTransactionStorage } from "../prisma/tenant-transaction.store";
import { PharmacistApprovalService } from "../sales/pharmacist-approval.service";
import { AccessService } from "../security/access.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { operationPermission } from "../security/operation-authorization.service";
import { TerminalTrustService } from "../terminals/terminal-trust.service";
import { boundedCanonical, denied, invalid, object, text, uuid } from "../terminals/terminal-wire";
import { SignedOperations } from "./signed-operations";
import { TERMINAL_EXECUTE } from "./terminal-command.executor";

type Tx = Prisma.TransactionClient;

/**
 * `POST /terminal-commands/pharmacist-cosigns`: a registered pharmacist co-signs one clinical command
 * for the person signed in at this counter, with their PIN (P1 #47). Contract: docs/API_CONTRACT.md.
 *
 * 1. The caller's open counter session and live authority for the operation are checked first, so
 *    nobody outside a counter session can spend guesses at a pharmacist's PIN.
 * 2. The PIN is checked by `PharmacistApprovalService.verifyApproverPin`, as at checkout: the
 *    co-signer needs the operation's own grant at the branch (`prescriptions.create`), and a wrong
 *    PIN is committed towards their own lockout before the refusal. The signed-in person needs the
 *    descriptor's `cosign.permission` instead (`sales.pos_use`), so a cashier can record.
 * 3. One transaction re-checks the session and authority, then issues the co-sign, which needs the
 *    co-signer's current registration (`APPROVER_NOT_QUALIFIED`).
 *
 * The PIN is used only in step 2. It is never stored, put in the co-sign, the command, its digest,
 * the receipt or an audit, and the terminal error filter logs codes, never request bodies.
 */
@Injectable()
export class PharmacistCosigns {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trust: TerminalTrustService,
    private readonly access: AccessService,
    private readonly approvals: PharmacistApprovalService,
    private readonly cosigns: PharmacistCosignService,
    private readonly operations: SignedOperations,
  ) {}

  async issue(user: RequestUser, branchId: string, raw: unknown): Promise<PharmacistCosign> {
    const request = object(raw, ["workSessionId", "operation", "body", "pharmacistUserId", "pin"]);
    if (typeof request.operation !== "string" || !isCosignable(request.operation)) invalid();
    const operation = request.operation;
    const { descriptor } = this.operations.get(operation);
    if (!descriptor.cosign) invalid();
    const body = descriptor.parseBody(request.body);
    if (boundedCanonical(body) !== boundedCanonical(request.body)) invalid();
    const workSessionId = uuid(request.workSessionId);
    const pharmacistUserId = uuid(request.pharmacistUserId);
    const pin = text(request.pin, 128);
    // The signed-in person's grant for a co-signed command; the co-signer needs the operation's own.
    const permission = operationPermission(descriptor, body, true);
    const cosignerPermission = operationPermission(descriptor, body);
    const check = (tx: Tx) => this.requireCounter(tx, user, branchId, workSessionId, permission);

    await this.transaction(user, branchId, check);
    await this.approvals.verifyApproverPin(user.tenantId, branchId, pharmacistUserId, pin, user.userId,
      cosignerPermission);
    return this.transaction(user, branchId, async (tx) => {
      await check(tx);
      return this.cosigns.issueInTransaction(tx, {
        tenantId: user.tenantId,
        branchId,
        workSessionId,
        staffUserId: user.userId,
        pharmacistUserId,
        operation,
        body,
      });
    });
  }

  /** The caller's own open session at this counter, with the route gate and the operation's grant live. */
  private async requireCounter(tx: Tx, user: RequestUser, branchId: string, workSessionId: string, permission: string) {
    await this.trust.requireOpenSession(tx, user, branchId, workSessionId);
    const actor = await this.access.resolveLive(user, branchId, tx);
    if (!actor.has(TERMINAL_EXECUTE) || !actor.has(permission)) denied("PERMISSION_DENIED");
  }

  private transaction<T>(user: RequestUser, branchId: string, work: (tx: Tx) => Promise<T>) {
    return this.prisma.$transaction((tx) =>
      tenantTransactionStorage.run({ tenantId: user.tenantId, branchId, client: tx }, () => work(tx)),
    );
  }
}
