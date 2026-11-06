import { Prisma, TillShiftCloseKind, type TillShift } from "@prisma/client";
import type {
  LocalOpenTillShift,
  OfflineShiftCloseCommand,
  OfflineShiftOpenCommand,
  OfflineStaffSignIn,
  OfflineTillShiftState,
  TerminalIdentity,
} from "@pharmaceylon/shared";
import type { AuditService } from "../../audit/audit.service";
import { nextDocumentNumber } from "../../common/document-sequence.util";
import type { TillShiftsService } from "../shifts/till-shifts.service";
import { expectedCash } from "../shifts/till-shift-math";

type Tx = Prisma.TransactionClient;

/** A till shift as the offline policy fixtures see it. A shift another enrollment opened keeps
 * that enrollment's identity, so the policy refuses to continue or close it from this journal. */
export function localOpenShift(identity: TerminalIdentity, shift: TillShift): LocalOpenTillShift {
  return {
    identity: { ...identity, terminalId: shift.terminalId, enrollmentId: shift.enrollmentId },
    session: {
      registerId: shift.registerId,
      tillId: shift.tillId,
      workSessionId: shift.id,
      staffUserId: shift.staffUserId,
    },
    openedAt: shift.openedAt.getTime(),
    openingCashMinor: shift.openingCashMinor,
  };
}

/**
 * The till's shift state now, for `offlineShiftTransition`, with the counter row locked so shift
 * opens and closes on this till serialize with online ones. Replay is in journal order, so "now"
 * is the state just before this command. `expectedCashMinor` is the counter's own figure from
 * the close command: the server's figure is recorded beside it, never used to refuse a count.
 */
export async function readTillShiftState(
  tx: Tx,
  identity: TerminalIdentity,
  till: { registerId: string; tillId: string },
  command: OfflineShiftOpenCommand | OfflineShiftCloseCommand,
): Promise<{ state: OfflineTillShiftState; open: TillShift | null }> {
  const { tenantId, branchId } = identity;
  await tx.$queryRaw`SELECT id FROM terminal_counter WHERE tenant_id = ${tenantId}::uuid
    AND branch_id = ${branchId}::uuid AND id = ${till.registerId}::uuid FOR UPDATE`;
  const open = await tx.tillShift.findFirst({ where: { tenantId, branchId, tillId: till.tillId, closedAt: null } });
  const lastClosed = await tx.tillShift.findFirst({
    where: { tenantId, branchId, tillId: till.tillId, closedAt: { not: null } },
    orderBy: { closedAt: "desc" },
    select: { id: true },
  });
  const used = await tx.tillShift.findFirst({
    where: { tenantId, id: command.session.workSessionId },
    select: { id: true },
  });
  return {
    open,
    state: {
      openShift: open ? localOpenShift(identity, open) : null,
      expectedCashMinor: command.kind === "shift_close" ? command.expectedCashMinor : open?.openingCashMinor ?? null,
      lastClosedWorkSessionId: lastClosed?.id ?? null,
      usedWorkSessionIds: used ? [used.id] : [],
    },
  };
}

/** D7b `shift_open`, replayed once: the counter-generated work session ID becomes the shift. */
export async function replayShiftOpen(
  tx: Tx,
  audit: AuditService,
  input: { identity: TerminalIdentity; command: OfflineShiftOpenCommand; uploadedByUserId: string },
): Promise<void> {
  const { identity, command } = input;
  const { tenantId, branchId } = identity;
  const shiftNumber = await nextDocumentNumber(tx, tenantId, branchId, "till_shift", "S-", 4);
  await tx.tillShift.create({
    data: {
      id: command.session.workSessionId,
      tenantId,
      branchId,
      shiftNumber,
      registerId: command.session.registerId,
      tillId: command.session.tillId,
      terminalId: identity.terminalId,
      enrollmentId: identity.enrollmentId,
      staffUserId: command.session.staffUserId,
      openedStaffSessionId: null,
      openCommandId: command.commandId,
      openedSignInId: command.staffSignInId,
      previousClosedWorkSessionId: command.previousClosedWorkSessionId,
      openedAt: new Date(command.occurredAt),
      openingCashMinor: command.openingCashMinor,
      // The offline command carries the counted total, not the notes and coins.
      openingCount: [],
    },
  });
  await audit.log(
    {
      tenantId,
      branchId,
      actorUserId: command.session.staffUserId,
      eventName: "till_shift.opened",
      entityName: "till_shift",
      entityId: command.session.workSessionId,
      payload: {
        offline: true,
        tillId: command.session.tillId,
        registerId: command.session.registerId,
        terminalId: identity.terminalId,
        shiftNumber,
        openingCashMinor: command.openingCashMinor,
        previousClosedWorkSessionId: command.previousClosedWorkSessionId,
        commandId: command.commandId,
        staffSignInId: command.staffSignInId,
        uploadedByUserId: input.uploadedByUserId,
      },
    },
    tx,
  );
}

/**
 * D7b `shift_close`, replayed once. The server's expected cash comes from the shift's own
 * replayed sales (as an online close), the counter's figure is kept beside it, and the variance
 * on record is the count less the server's figure. An assisted close names the manager who
 * signed in for it; the shift stays the cashier's.
 */
export async function replayShiftClose(
  tx: Tx,
  deps: { audit: AuditService; shifts: Pick<TillShiftsService, "parts"> },
  input: {
    identity: TerminalIdentity;
    command: OfflineShiftCloseCommand;
    signIn: OfflineStaffSignIn;
    shift: TillShift;
    uploadedByUserId: string;
  },
): Promise<void> {
  const { identity, command, signIn, shift } = input;
  const { tenantId, branchId } = identity;
  // Waits for anything still adding money to the shift.
  await tx.$queryRaw`SELECT id FROM till_shift WHERE tenant_id = ${tenantId}::uuid
    AND branch_id = ${branchId}::uuid AND id = ${shift.id}::uuid FOR UPDATE`;
  const expected = expectedCash(await deps.shifts.parts(tx, shift));
  const assisted = command.assistance !== null;
  const variance = command.closingCashCountMinor - expected;
  await tx.tillShift.update({
    where: { id: shift.id, tenantId, branchId },
    data: {
      closedAt: new Date(command.occurredAt),
      closingCashCountMinor: command.closingCashCountMinor,
      closingCount: [],
      expectedCashMinor: expected,
      counterExpectedCashMinor: command.expectedCashMinor,
      varianceMinor: variance,
      closedByUserId: signIn.session.staffUserId,
      closedSignInId: signIn.staffSignInId,
      closeKind: assisted ? TillShiftCloseKind.assisted : TillShiftCloseKind.self,
      assistanceReason: command.assistance?.reason ?? null,
      closeCommandId: command.commandId,
    },
  });
  await deps.audit.log(
    {
      tenantId,
      branchId,
      actorUserId: signIn.session.staffUserId,
      eventName: "till_shift.closed",
      entityName: "till_shift",
      entityId: shift.id,
      payload: {
        offline: true,
        tillId: shift.tillId,
        staffUserId: shift.staffUserId,
        closedByUserId: signIn.session.staffUserId,
        closeKind: assisted ? "assisted" : "self",
        assistanceReason: command.assistance?.reason ?? null,
        expectedCashMinor: expected,
        counterExpectedCashMinor: command.expectedCashMinor,
        closingCashCountMinor: command.closingCashCountMinor,
        varianceMinor: variance,
        commandId: command.commandId,
        staffSignInId: signIn.staffSignInId,
        uploadedByUserId: input.uploadedByUserId,
      },
    },
    tx,
  );
}
