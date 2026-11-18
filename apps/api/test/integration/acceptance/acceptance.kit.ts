import { randomUUID } from "node:crypto";
import type { OnlineTerminalCommand, SignedPhysicalOperation, SyncAcknowledgement } from "@pharmaceylon/shared";
import { JournalReviewsService } from "../../../src/journal-reviews/journal-reviews.service";
import { ManagementApprovalsService } from "../../../src/security/management-approvals.service";
import { MandatoryOperationEvidence } from "../../../src/security/mandatory-operation-evidence";
import { OperationAuthorizationService } from "../../../src/security/operation-authorization.service";
import type { RequestUser } from "../../../src/security/interfaces/authenticated-request.interface";
import { StockCasesService } from "../../../src/stock-cases/stock-cases.service";
import { SignedOperations } from "../../../src/terminal-commands/signed-operations";
import { TerminalCommandExecutor } from "../../../src/terminal-commands/terminal-command.executor";
import { acceptedJournalState } from "../../../src/terminals/offline-authority-issuance";
import {
  access,
  attest,
  audit,
  offlineJournal,
  prisma,
  proofs,
  sales,
  saleAck,
  shifts,
  stock,
  sync,
  trust,
  type Counter,
} from "../offline-counter.kit";

/**
 * P5 #51 acceptance harness: the services a manager and the nominated counter use after an
 * offline journal arrives, wired exactly as the slice suites wire them. A1–A9 sign fixture journals
 * (`offline-counter.kit`); `a10-real-counter-journal` runs the same scenarios on journals written
 * by the real P4 #50 offline checkout.
 */
class OpenHours extends MandatoryOperationEvidence {
  override async hours() {}
}
export const approvals = new ManagementApprovalsService(access, audit);
export const cases = new StockCasesService(prisma as never, audit, access, approvals, stock);
export const reviews = new JournalReviewsService(prisma as never, audit, access, approvals, stock, shifts);
export const authorization = new OperationAuthorizationService(access, trust, new OpenHours({} as never, {} as never), approvals);
export const operations = new SignedOperations({} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
  {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, cases);
export const executor = new TerminalCommandExecutor(prisma as never, trust, authorization, operations, audit, access);
export const RESOLVE = "POST /api/v1/offline-stock-cases/resolutions/:id/execute" satisfies SignedPhysicalOperation;
export type Counts = Array<{ batchId: string; countedQty: number }>;

export const branch = (c: Counter) => c.fx.mainBranchId;
export const statuses = (acks: readonly SyncAcknowledgement[]) => acks.map((a) => a.status);

/** The staff member's open, attended session at the nominated counter. */
export async function sessionFor(c: Counter, staff: RequestUser) {
  const open = await prisma.terminalStaffSession.findFirst({
    where: { tenantId: c.fx.tenantId, enrollmentId: c.identity.enrollmentId, staffUserId: staff.userId, closedAt: null },
  });
  if (open) return open.id;
  const payload = await prisma.$transaction((t) => trust.beginSession(t, staff, branch(c), c.identity));
  const a = attest(c.fx, payload, "session", staff);
  const proof = await proofs.record(staff, branch(c), c.device.sign(a, c.identity.keyId, "attendance"));
  const { workSessionId } = await prisma.$transaction((t) =>
    trust.finishSession(t, staff, branch(c), c.device.sign(payload, c.identity.keyId), proof.proofId));
  return workSessionId;
}

/** A signed, attended command to execute a stock case resolution at the nominated counter. */
export async function signedResolve(c: Counter, staff: RequestUser, resolutionId: string, counts: Counts, approvalId: string | null) {
  const workSessionId = await sessionFor(c, staff);
  const payload = await executor.prepare(staff, branch(c), {
    workSessionId, operation: RESOLVE, body: { resolutionId, counts }, approvalEvidenceId: approvalId,
    pharmacistEvidenceId: null, operatingHoursExceptionId: null,
  }) as OnlineTerminalCommand<unknown>;
  const a = attest(c.fx, payload, "command", staff);
  const proof = await proofs.record(staff, branch(c), c.device.sign(a, c.identity.keyId, "attendance"));
  return { command: c.device.sign(payload, c.identity.keyId), attendanceProofId: proof.proofId };
}
export const run = (c: Counter, staff: RequestUser, request: unknown) => executor.execute(staff, branch(c), request);

export type Journal = { j: ReturnType<typeof offlineJournal>; cashierIn: ReturnType<ReturnType<typeof offlineJournal>["signIn"]> };
/** One offline sale synced from the nominated counter; the first opens the offline shift. */
export async function offlineSale(c: Counter, items: Array<[string, number]>, on?: Journal) {
  if (on) {
    const response = await sync(c, { commands: [on.j.sale(on.cashierIn, items)] });
    return { ...on, ack: saleAck(response.payload.acknowledgements[0]!) };
  }
  const j = offlineJournal(c);
  const cashierIn = j.signIn(c.cashier.userId, randomUUID());
  const response = await sync(c, { staffSignIns: [cashierIn], commands: [j.open(cashierIn, 0), j.sale(cashierIn, items)] });
  return { ack: saleAck(response.payload.acknowledgements[1]!), j, cashierIn };
}

/** A central (online) checkout at the same branch, from a named batch or by FEFO. */
export const onlineSale = (c: Counter, batchId: string | undefined, qty: number) =>
  sales.checkout(c.fx.tenantId, branch(c), c.owner.userId, [],
    { items: [{ productId: c.fx.productId, ...(batchId ? { batchId } : {}), qty, unitPrice: "15.50" }] } as never, undefined);

/** Batches a fresh snapshot for any counter at the branch would mark for review. */
export const reviewSet = async (c: Counter) =>
  [...(await prisma.$transaction((tx) => acceptedJournalState(tx, { ...c.identity, enrollmentId: randomUUID() }))).reviewRequiredBatchIds].sort();

export async function selfApproval(c: Counter, roles: string[]) {
  await prisma.tenantSettings.upsert({
    where: { tenantId: c.fx.tenantId },
    create: { tenantId: c.fx.tenantId, selfApprovalRoleKeys: roles },
    update: { selfApprovalRoleKeys: roles },
  });
}

/** Everything one offline sale could have done to the books, for "one business effect" checks. */
export async function effects(c: Counter) {
  const where = { tenantId: c.fx.tenantId };
  return {
    sales: await prisma.sale.count({ where }),
    payments: await prisma.salePayment.count({ where }),
    saleLedger: await prisma.stockLedger.count({ where: { ...where, referenceType: "sale" } }),
    receipts: await prisma.terminalCommandReceipt.count({ where }),
    cases: await prisma.offlineStockDiscrepancy.count({ where }),
    shifts: await prisma.tillShift.count({ where }),
  };
}
