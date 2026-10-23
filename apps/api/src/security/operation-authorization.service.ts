import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { AccessService } from "./access.service";
import {
  classifyMutation,
  type ResolvedActionFacts,
} from "./operation-classification";
import type { RequestUser } from "./interfaces/authenticated-request.interface";
import { TerminalTrustService } from "../terminals/terminal-trust.service";
import {
  boundedCanonical,
  denied,
  type BodyParser,
} from "../terminals/terminal-wire";
import { MandatoryOperationEvidence } from "./mandatory-operation-evidence";
import { ManagementApprovalsService } from "./management-approvals.service";
import { approvalAction, type ApprovalAction } from "./approval-documents";
import { PERMISSION_KEYS } from "./permission-catalog";

/** Supplied only by a reviewed server domain adapter, NEVER deserialized from HTTP.
 * Conditional facts must read validated product/payment state on this transaction.
 * Domain adapters retain quantity/refund caps and must not hide effects in a callback.
 */
export type OperationDescriptor<T> = Readonly<{
  method: string;
  routeTemplate: string;
  permission: string;
  parseBody: BodyParser<T>;
  resolveFacts?: (
    tx: Prisma.TransactionClient,
    user: RequestUser,
    branchId: string,
    body: T,
  ) => Promise<ResolvedActionFacts>;
  approval?: { action: ApprovalAction; documentId: (body: T) => string };
}>;

/** Extends existing AccessService authorization at the transactional service boundary,
 * not a fifth guard. Existing routes are not cut over until domain/P2 adapters are ready.
 * All business effects, success audit and receipt must use this SAME transaction.
 */
@Injectable()
export class OperationAuthorizationService {
  constructor(
    private readonly access: AccessService,
    private readonly terminals: TerminalTrustService,
    private readonly evidence: MandatoryOperationEvidence,
    private readonly approvals: ManagementApprovalsService,
  ) {}

  async authorize<T>(
    tx: Prisma.TransactionClient,
    user: RequestUser,
    branchId: string,
    descriptor: OperationDescriptor<T>,
    input: {
      body: unknown;
      signedCommand?: unknown;
      attendanceProofId?: string;
    },
  ) {
    if (!PERMISSION_KEYS.includes(descriptor.permission))
      denied("INVALID_COMMAND");
    const body = descriptor.parseBody(input.body);
    if (boundedCanonical(body) !== boundedCanonical(input.body))
      denied("INVALID_COMMAND");
    const actor = await this.access.resolveLive(user, branchId, tx);
    if (!actor.has(descriptor.permission)) denied("PERMISSION_DENIED");
    const facts = descriptor.resolveFacts
      ? await descriptor.resolveFacts(tx, user, branchId, body)
      : undefined;
    let classification = classifyMutation(
      descriptor.method,
      descriptor.routeTemplate,
      facts,
    );
    const operation = `${descriptor.method} ${descriptor.routeTemplate}`;
    if (!classification.requiresLocalTerminal) {
      if (descriptor.approval) denied("INVALID_COMMAND");
      if (classification.effects.includes("bank_payment_record"))
        await this.evidence.bankPayment(tx, {
          tenantId: user.tenantId,
          branchId,
          actorUserId: user.userId,
          operation,
          body,
        });
      // Evidence/fact providers can block; never reuse pre-wait authority.
      const current = await this.access.resolveLive(user, branchId, tx);
      if (!current.has(descriptor.permission)) denied("PERMISSION_DENIED");
      const latest = classifyMutation(
        descriptor.method,
        descriptor.routeTemplate,
        descriptor.resolveFacts
          ? await descriptor.resolveFacts(tx, user, branchId, body)
          : undefined,
      );
      if (boundedCanonical(latest) !== boundedCanonical(classification))
        denied("INVALID_COMMAND");
      return { body, classification, terminal: null, approval: null };
    }
    if (!input.signedCommand || !input.attendanceProofId)
      denied("TERMINAL_REQUIRED");
    const terminal = await this.terminals.verifyCommand(
      tx,
      user,
      branchId,
      {
        operation,
        permission: descriptor.permission,
        parseBody: descriptor.parseBody,
      },
      input.signedCommand,
      input.attendanceProofId,
    );
    if (boundedCanonical(terminal.command.body) !== boundedCanonical(body))
      denied("INVALID_COMMAND");
    let approval = null;
    if (descriptor.approval) {
      const policy = approvalAction(descriptor.approval.action);
      if (
        policy.operation !== operation ||
        policy.executionPermission !== descriptor.permission
      )
        denied("INVALID_COMMAND");
      if (!terminal.command.approvalEvidenceId) denied("APPROVAL_REQUIRED");
      approval = await this.approvals.requireForExecution(
        tx,
        user,
        branchId,
        descriptor.approval.action,
        descriptor.approval.documentId(body),
        terminal.command.approvalEvidenceId,
      );
    } else if (terminal.command.approvalEvidenceId !== null)
      denied("APPROVAL_INVALID");
    // Re-resolve and check mandatory evidence AFTER terminal/document/evidence locks.
    classification = classifyMutation(
      descriptor.method,
      descriptor.routeTemplate,
      descriptor.resolveFacts
        ? await descriptor.resolveFacts(tx, user, branchId, body)
        : undefined,
    );
    if (classification.effects.includes("clinical_dispensing"))
      await this.evidence.clinical(tx, terminal.command);
    if (classification.effects.includes("bank_payment_record"))
      await this.evidence.bankPayment(tx, {
        tenantId: user.tenantId,
        branchId,
        actorUserId: user.userId,
        operation,
        body,
      });
    await this.evidence.hours(tx, terminal.command);
    const current = await this.access.resolveLive(user, branchId, tx);
    if (!current.has(descriptor.permission)) denied("PERMISSION_DENIED");
    return { body, classification, terminal, approval };
  }
}
