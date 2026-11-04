import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PaymentMethod, Prisma, SaleStatus, TillCashMovementDirection, TillShiftCloseKind, type TillShift } from "@prisma/client";
import { AuditService } from "../../audit/audit.service";
import { safeTimeZone } from "../../common/business-date.util";
import { PrismaService } from "../../prisma/prisma.service";
import { AccessService } from "../../security/access.service";
import type { RequestUser } from "../../security/interfaces/authenticated-request.interface";
import { OperatingHoursEvidence } from "../operating-hours.evidence";
import { PinAlerts } from "../pin-alerts.service";
import { checkPosPin, pinRefusal, type PinRefused } from "../pos-pin";
import { TerminalTrustService } from "../terminal-trust.service";
import {
  branchHourKey,
  CashCountError,
  expectedCash,
  parseCashCount,
  toMinor,
  type CashCount,
  type ExpectedCashParts,
} from "./till-shift-math";
import type { CashCountDto, CloseTillShiftDto, OpenTillShiftDto } from "./till-shift.dto";

type Tx = Prisma.TransactionClient;
type Client = Tx | PrismaService;

export const CLOSE_OTHERS_PERMISSION = "shifts.close_others";

function conflict(code: string, message: string, extra: Record<string, unknown> = {}): never {
  throw new ConflictException({ code, message, ...extra });
}

function count(raw: CashCountDto): CashCount {
  try {
    return parseCashCount(raw);
  } catch (error) {
    if (error instanceof CashCountError)
      throw new BadRequestException({ code: "CASH_COUNT_INVALID", message: error.message });
    throw error;
  }
}

/** JSONB keeps its own key order, so compare the lines field by field. */
const sameCount = (stored: Prisma.JsonValue | null, next: CashCount) => {
  const lines = (Array.isArray(stored) ? stored : []) as Array<{ denominationMinor?: unknown; count?: unknown }>;
  return (
    lines.length === next.lines.length &&
    lines.every((line, i) => line.denominationMinor === next.lines[i]!.denominationMinor && line.count === next.lines[i]!.count)
  );
};

type Person = { id: string; fullName: string } | null;

/** A shift as the counter and P4/P5 see it: D7b's fields, in minor units. */
export type TillShiftView = Readonly<{
  workSessionId: string;
  registerId: string;
  tillId: string;
  terminalId: string;
  staffUserId: string;
  staff: Person;
  currency: "LKR";
  status: "open" | "closed";
  openedAt: string;
  openingCashMinor: number;
  openingCount: CashCount["lines"];
  previousClosedWorkSessionId: string | null;
  closedAt: string | null;
  closingCashCountMinor: number | null;
  closingCount: CashCount["lines"] | null;
  expectedCashMinor: number | null;
  counterExpectedCashMinor: number | null;
  varianceMinor: number | null;
  closedBy: Person;
  closeKind: "self" | "assisted" | null;
  assistanceReason: string | null;
  /** What the person who counted said about a difference. */
  varianceNote: string | null;
}>;

export type TillShiftSummary = ExpectedCashParts & Readonly<{
  /** Live for an open shift; the recorded figure once closed. */
  expectedCashMinor: number;
  saleCount: number;
  salesTotalMinor: number;
  /** Takings by how they were paid. Cash is net of change; refunds paid back that way beside it. */
  takingsByMethod: ReadonlyArray<Readonly<{ method: PaymentMethod; saleCount: number; takenMinor: number; refundedMinor: number }>>;
  /** When the shift's first and last sales were rung up; null with none. */
  firstSaleAt: string | null;
  lastSaleAt: string | null;
  /** Sales by the branch's own clock hour, `YYYY-MM-DDTHH`, earliest first. */
  takingsByHour: ReadonlyArray<Readonly<{ hour: string; saleCount: number; totalMinor: number }>>;
  refunds: ReadonlyArray<Readonly<{
    goodsReturnId: string;
    returnNumber: string;
    invoiceNo: string | null;
    amountMinor: number;
    /** How the money went back, e.g. all cash, or card first then cash. */
    paidBack: ReadonlyArray<Readonly<{ method: PaymentMethod; amountMinor: number }>>;
    /** What came back, for the counter's list ("Panadol, 2 strips"). */
    items: ReadonlyArray<Readonly<{ name: string; qty: number; disposition: "restock" | "quarantine" }>>;
    processedBy: Person;
    at: string;
  }>>;
  cashMovements: ReadonlyArray<Readonly<{
    id: string;
    direction: "in" | "out";
    amountMinor: number;
    reason: string;
    referenceType: string | null;
    at: string;
    recordedBy: Person;
  }>>;
}>;

export type TillShiftDetail = Readonly<{ shift: TillShiftView; summary: TillShiftSummary }>;

/**
 * Online till shifts and cash (P2b #103, D7b's online form). One person's shift on one till,
 * opened with their own PIN and a counted drawer, closed with another count. The server's
 * expected cash is the record online; the counter keeps its own running figure beside it.
 *
 * Every counter sale and cash refund belongs to the seller's own open shift on that till
 * (`requireForSale`, `forCounterRefund`), and every other movement of drawer cash goes through
 * `recordCashMovement`. Lock order: the shift row (FOR SHARE to add money, FOR UPDATE to close),
 * so a close waits for in-flight sales and nothing lands on a shift once it has closed.
 */
@Injectable()
export class TillShiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trust: TerminalTrustService,
    private readonly hours: OperatingHoursEvidence,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly alerts: PinAlerts,
  ) {}

  // ── counter routes ────────────────────────────────────────────────────────────────────────

  /** The open shift on the caller's till (with its running totals) and the last closed one. */
  async current(user: RequestUser, branchId: string, staffSessionId: string) {
    const { tillId, registerId } = await this.prisma.$transaction(async (tx) => {
      const { session } = await this.trust.requireOpenSession(tx, user, branchId, staffSessionId);
      return session;
    });
    const tenantId = user.tenantId;
    const [open, lastClosed] = await Promise.all([
      this.prisma.tillShift.findFirst({ where: { tenantId, branchId, tillId, closedAt: null } }),
      this.prisma.tillShift.findFirst({
        where: { tenantId, branchId, tillId, closedAt: { not: null } },
        orderBy: { closedAt: "desc" },
      }),
    ]);
    const views = await this.views(tenantId, [open, lastClosed].filter((s): s is TillShift => !!s));
    return {
      registerId,
      tillId,
      current: open ? { shift: views.get(open.id)!, summary: await this.summary(this.prisma, open) } : null,
      lastClosed: lastClosed ? views.get(lastClosed.id)! : null,
    };
  }

  /** Shifts on the caller's till, newest first. */
  async list(user: RequestUser, branchId: string, staffSessionId: string) {
    const tillId = await this.till(user, branchId, staffSessionId);
    const rows = await this.prisma.tillShift.findMany({
      where: { tenantId: user.tenantId, branchId, tillId },
      orderBy: { openedAt: "desc" },
      take: 30,
    });
    const views = await this.views(user.tenantId, rows);
    return rows.map((row) => views.get(row.id)!);
  }

  /** One shift on the caller's till, with its totals: past shifts and the X report read this. */
  async detail(user: RequestUser, branchId: string, staffSessionId: string, shiftId: string): Promise<TillShiftDetail> {
    const tillId = await this.till(user, branchId, staffSessionId);
    return this.detailOnTill(user.tenantId, branchId, tillId, shiftId);
  }

  /** D7b `shift_open`, online: the caller's own PIN, a count, no shift already open on the till. */
  async open(user: RequestUser, branchId: string, staffSessionId: string, dto: OpenTillShiftDto): Promise<TillShiftDetail> {
    const opening = count(dto.openingCount);
    const tenantId = user.tenantId;
    const outcome = await this.prisma.$transaction(async (tx) => {
      const { session, identity } = await this.trust.requireOpenSession(tx, user, branchId, staffSessionId);
      // The till's opens serialize here; the partial unique index is the backstop.
      await tx.$queryRaw`SELECT id FROM terminal_counter WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${session.registerId}::uuid FOR UPDATE`;

      // A resend of an open that landed replays it; the same ID for anything else is refused.
      const existing = await tx.tillShift.findFirst({ where: { tenantId, id: dto.shiftId } });
      if (existing) {
        if (
          existing.branchId === branchId &&
          existing.tillId === session.tillId &&
          existing.staffUserId === user.userId &&
          existing.openingCashMinor === opening.totalMinor &&
          sameCount(existing.openingCount, opening)
        )
          return { kind: "opened" as const, tillId: session.tillId };
        conflict("SHIFT_ID_USED", "That shift was already opened differently. Start again.");
      }

      const open = await tx.tillShift.findFirst({ where: { tenantId, branchId, tillId: session.tillId, closedAt: null } });
      if (open) {
        const holder = await this.person(tx, tenantId, open.staffUserId);
        conflict(
          open.staffUserId === user.userId ? "SHIFT_ALREADY_OPEN" : "SHIFT_HELD_BY_OTHER",
          open.staffUserId === user.userId
            ? "Your shift is already open on this till."
            : `${holder?.fullName ?? "Someone else"}'s shift is still open on this till. They count the drawer and close it first, or a manager closes it for them.`,
          { workSessionId: open.id, staffUserId: open.staffUserId, openedAt: open.openedAt.toISOString() },
        );
      }
      const last = await tx.tillShift.findFirst({
        where: { tenantId, branchId, tillId: session.tillId, closedAt: { not: null } },
        orderBy: { closedAt: "desc" },
        select: { id: true },
      });
      if (dto.previousClosedWorkSessionId !== undefined && (dto.previousClosedWorkSessionId ?? null) !== (last?.id ?? null))
        conflict("SHIFT_STATE_CHANGED", "This till's shifts changed. Check the till and try again.");

      // Opening follows checkout's hours rules (revised D8: new sales and shift opening).
      await this.hours.assertMandatoryForSale(tx, tenantId, branchId);

      // The PIN last, so a refusal for any other reason doesn't spend a guess.
      const refused = await this.checkOwnPin(tx, user, dto.pin);
      if (refused) return { kind: "pin" as const, refused };

      try {
        await tx.tillShift.create({
          data: {
            id: dto.shiftId,
            tenantId,
            branchId,
            registerId: session.registerId,
            tillId: session.tillId,
            terminalId: identity.terminalId,
            enrollmentId: identity.enrollmentId,
            staffUserId: user.userId,
            openedStaffSessionId: session.id,
            previousClosedWorkSessionId: last?.id ?? null,
            openingCashMinor: opening.totalMinor,
            openingCount: opening.lines as unknown as Prisma.InputJsonValue,
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
          conflict("SHIFT_ALREADY_OPEN", "A shift is already open on this till.");
        throw error;
      }
      await this.audit.log(
        {
          tenantId,
          branchId,
          actorUserId: user.userId,
          eventName: "till_shift.opened",
          entityName: "till_shift",
          entityId: dto.shiftId,
          payload: {
            tillId: session.tillId,
            registerId: session.registerId,
            terminalId: identity.terminalId,
            staffSessionId: session.id,
            openingCashMinor: opening.totalMinor,
            previousClosedWorkSessionId: last?.id ?? null,
          },
        },
        tx,
      );
      return { kind: "opened" as const, tillId: session.tillId };
    });
    if (outcome.kind === "pin") return this.refusePin(user, branchId, outcome.refused);
    return this.detailOnTill(tenantId, branchId, outcome.tillId, dto.shiftId);
  }

  /**
   * D7b `shift_close`, online. The shift's own person counts and closes it; anyone else is the
   * absent-cashier close, which needs `shifts.close_others`, their own PIN and a reason, and
   * leaves the original person on the record. Allowed outside selling hours (D8).
   */
  async close(
    user: RequestUser,
    branchId: string,
    staffSessionId: string,
    shiftId: string,
    dto: CloseTillShiftDto,
  ): Promise<TillShiftDetail> {
    const closing = count(dto.closingCount);
    const tenantId = user.tenantId;
    const outcome = await this.prisma.$transaction(async (tx) => {
      const { session } = await this.trust.requireOpenSession(tx, user, branchId, staffSessionId);
      // Waits for sales and refunds still adding to this shift (they hold it FOR SHARE).
      await tx.$queryRaw`SELECT id FROM till_shift WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${shiftId}::uuid FOR UPDATE`;
      const shift = await tx.tillShift.findFirst({ where: { tenantId, branchId, id: shiftId } });
      if (!shift || shift.tillId !== session.tillId)
        throw new NotFoundException({ code: "SHIFT_NOT_FOUND", message: "That shift isn't on this till." });
      if (shift.closedAt) {
        if (shift.closeCommandId === dto.commandId) return { kind: "closed" as const, tillId: shift.tillId };
        conflict("SHIFT_ALREADY_CLOSED", "This shift is already closed.", { workSessionId: shift.id });
      }

      const assisted = shift.staffUserId !== user.userId;
      let reason: string | null = null;
      if (assisted) {
        if (!dto.assistance) {
          const holder = await this.person(tx, tenantId, shift.staffUserId);
          throw new ForbiddenException({
            code: "SHIFT_ASSISTANCE_REQUIRED",
            message: `This is ${holder?.fullName ?? "someone else"}'s shift. A manager closes it for them with their own PIN and a reason.`,
          });
        }
        const actor = await this.access.resolveLive(user, branchId, tx);
        if (!actor.has(CLOSE_OTHERS_PERMISSION))
          throw new ForbiddenException({
            code: "PERMISSION_DENIED",
            message: "Your role can't close someone else's shift. Ask a manager.",
          });
        reason = dto.assistance.reason.trim();
        if (!reason) throw new BadRequestException({ code: "REASON_REQUIRED", message: "Say why you're closing their shift." });
      } else if (dto.assistance) {
        throw new BadRequestException({ code: "INVALID_COMMAND", message: "Your own shift closes without a manager." });
      }

      const parts = await this.parts(tx, shift);
      const expected = expectedCash(parts);
      if (assisted) {
        const refused = await this.checkOwnPin(tx, user, dto.assistance!.pin);
        if (refused) return { kind: "pin" as const, refused };
      }
      const closedAt = new Date();
      try {
        await tx.tillShift.update({
          where: { id: shift.id, tenantId, branchId },
          data: {
            closedAt,
            closingCashCountMinor: closing.totalMinor,
            closingCount: closing.lines as unknown as Prisma.InputJsonValue,
            expectedCashMinor: expected,
            counterExpectedCashMinor: dto.counterExpectedCashMinor ?? null,
            varianceMinor: closing.totalMinor - expected,
            closedByUserId: user.userId,
            closedStaffSessionId: session.id,
            closeKind: assisted ? TillShiftCloseKind.assisted : TillShiftCloseKind.self,
            assistanceReason: reason,
            varianceNote: dto.varianceNote?.trim() || null,
            closeCommandId: dto.commandId,
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
          conflict("SHIFT_COMMAND_USED", "That close was already used for another shift. Start again.");
        throw error;
      }
      await this.audit.log(
        {
          tenantId,
          branchId,
          actorUserId: user.userId,
          eventName: "till_shift.closed",
          entityName: "till_shift",
          entityId: shift.id,
          payload: {
            tillId: shift.tillId,
            staffUserId: shift.staffUserId,
            closedByUserId: user.userId,
            closeKind: assisted ? "assisted" : "self",
            assistanceReason: reason,
            varianceNote: dto.varianceNote?.trim() || null,
            expectedCashMinor: expected,
            counterExpectedCashMinor: dto.counterExpectedCashMinor ?? null,
            closingCashCountMinor: closing.totalMinor,
            varianceMinor: closing.totalMinor - expected,
            commandId: dto.commandId,
          },
        },
        tx,
      );
      return { kind: "closed" as const, tillId: shift.tillId };
    });
    if (outcome.kind === "pin") return this.refusePin(user, branchId, outcome.refused);
    return this.detailOnTill(tenantId, branchId, outcome.tillId, shiftId);
  }

  // ── money attaching to a shift, in the caller's transaction ─────────────────────────────

  /**
   * The seller's own open shift on this till, share-locked for the rest of the caller's
   * transaction. A counter sale without one is refused: open a shift first, or hand over.
   * The refusal comes after checkout's idempotency lookup, so the counter may treat it as final.
   */
  async requireForSale(tx: Tx, at: { tenantId: string; branchId: string; tillId: string; userId: string }): Promise<string> {
    const shift = await this.lockOpen(tx, at);
    if (!shift)
      conflict("SHIFT_REQUIRED", "Open a shift on this till before selling: count the drawer and enter your PIN.");
    if (shift.staffUserId !== at.userId) {
      const holder = await this.person(tx, at.tenantId, shift.staffUserId);
      conflict(
        "SHIFT_HELD_BY_OTHER",
        `${holder?.fullName ?? "Someone else"}'s shift is open on this till. They count the drawer and close it before you open yours.`,
        { workSessionId: shift.id, staffUserId: shift.staffUserId },
      );
    }
    return shift.id;
  }

  /**
   * The shift a refund executed at a counter belongs to. A cash refund comes out of the
   * executor's own open shift on that till and is refused without one; a refund paying no cash
   * joins that shift when there is one.
   */
  async forCounterRefund(
    tx: Tx,
    at: { tenantId: string; branchId: string; tillId: string; userId: string; paysCash: boolean },
  ): Promise<string | null> {
    if (at.paysCash) return this.requireForSale(tx, at).catch((error: unknown) => {
      if (error instanceof ConflictException) {
        const body = error.getResponse() as { code?: string };
        if (body.code === "SHIFT_REQUIRED")
          conflict("SHIFT_REQUIRED", "A cash refund comes out of your open shift's drawer. Open a shift on this till first.");
      }
      throw error;
    });
    const shift = await this.lockOpen(tx, at);
    return shift && shift.staffUserId === at.userId ? shift.id : null;
  }

  /**
   * Cash into or out of the drawer that is neither a sale nor a refund — first, a supplier cash
   * payout approved on the web (P6, revised D10). In the payer's transaction, on their own open
   * shift on that till.
   */
  async recordCashMovement(
    tx: Tx,
    input: {
      tenantId: string;
      branchId: string;
      tillId: string;
      userId: string;
      direction: "in" | "out";
      amountMinor: number;
      reason: string;
      referenceType?: string | null;
      referenceId?: string | null;
    },
  ) {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
      throw new BadRequestException("A cash movement is a positive amount");
    const shiftId = await this.requireForSale(tx, input);
    const row = await tx.tillCashMovement.create({
      data: {
        tenantId: input.tenantId,
        branchId: input.branchId,
        shiftId,
        direction: input.direction === "in" ? TillCashMovementDirection.in : TillCashMovementDirection.out,
        amountMinor: input.amountMinor,
        reason: input.reason.trim(),
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        recordedBy: input.userId,
      },
    });
    await this.audit.log(
      {
        tenantId: input.tenantId,
        branchId: input.branchId,
        actorUserId: input.userId,
        eventName: "till_shift.cash_movement",
        entityName: "till_shift",
        entityId: shiftId,
        payload: { movementId: row.id, direction: input.direction, amountMinor: input.amountMinor,
          referenceType: row.referenceType, referenceId: row.referenceId },
      },
      tx,
    );
    return row;
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────

  private async lockOpen(tx: Tx, at: { tenantId: string; branchId: string; tillId: string }) {
    const rows = await tx.$queryRaw<Array<{ id: string; staff_user_id: string }>>`
      SELECT id, staff_user_id FROM till_shift
       WHERE tenant_id = ${at.tenantId}::uuid AND branch_id = ${at.branchId}::uuid
         AND till_id = ${at.tillId}::uuid AND closed_at IS NULL
       FOR SHARE`;
    const row = rows[0];
    return row ? { id: row.id, staffUserId: row.staff_user_id } : null;
  }

  private async till(user: RequestUser, branchId: string, staffSessionId: string) {
    return this.prisma.$transaction(async (tx) => {
      const { session } = await this.trust.requireOpenSession(tx, user, branchId, staffSessionId);
      return session.tillId;
    });
  }

  private async detailOnTill(tenantId: string, branchId: string, tillId: string, shiftId: string): Promise<TillShiftDetail> {
    const shift = await this.prisma.tillShift.findFirst({ where: { tenantId, branchId, tillId, id: shiftId } });
    if (!shift) throw new NotFoundException({ code: "SHIFT_NOT_FOUND", message: "That shift isn't on this till." });
    const views = await this.views(tenantId, [shift]);
    return { shift: views.get(shift.id)!, summary: await this.summary(this.prisma, shift) };
  }

  /** The cash figures behind expected cash, from the shift's own rows. Voided sales are left
   * out: a void hands the money back and records no payment. */
  async parts(client: Client, shift: Pick<TillShift, "id" | "tenantId" | "openingCashMinor">): Promise<ExpectedCashParts> {
    const [cash] = await client.$queryRaw<Array<{ taken: string | null; refunded: string | null }>>`
      SELECT SUM(CASE WHEN p.amount > 0 THEN p.amount ELSE 0 END)::text AS taken,
             SUM(CASE WHEN p.amount < 0 THEN -p.amount ELSE 0 END)::text AS refunded
        FROM sale_payment p JOIN sale s ON s.id = p.sale_id AND s.tenant_id = p.tenant_id
       WHERE p.tenant_id = ${shift.tenantId}::uuid AND p.shift_id = ${shift.id}::uuid
         AND p.method = 'cash' AND s.status <> 'voided'`;
    const [change] = await client.$queryRaw<Array<{ change: string | null }>>`
      SELECT SUM(change_due)::text AS change FROM sale
       WHERE tenant_id = ${shift.tenantId}::uuid AND shift_id = ${shift.id}::uuid AND status <> 'voided'`;
    const [moved] = await client.$queryRaw<Array<{ paid_out: bigint | null; paid_in: bigint | null }>>`
      SELECT SUM(CASE WHEN direction = 'out' THEN amount_minor ELSE 0 END) AS paid_out,
             SUM(CASE WHEN direction = 'in' THEN amount_minor ELSE 0 END) AS paid_in
        FROM till_cash_movement WHERE tenant_id = ${shift.tenantId}::uuid AND shift_id = ${shift.id}::uuid`;
    return {
      openingCashMinor: shift.openingCashMinor,
      cashTakenMinor: toMinor(cash?.taken),
      changeGivenMinor: toMinor(change?.change),
      cashRefundsMinor: toMinor(cash?.refunded),
      cashPaidOutMinor: Number(moved?.paid_out ?? 0),
      cashPaidInMinor: Number(moved?.paid_in ?? 0),
    };
  }

  private async summary(client: Client, shift: TillShift): Promise<TillShiftSummary> {
    const { tenantId, id: shiftId } = shift;
    const [parts, payments, sales, refunds, movements, branch] = await Promise.all([
      this.parts(client, shift),
      client.salePayment.findMany({
        where: { tenantId, shiftId, sale: { status: { not: SaleStatus.voided } } },
        select: { method: true, amount: true, saleId: true, reference: true },
      }),
      client.sale.findMany({
        where: { tenantId, shiftId, status: { not: SaleStatus.voided } },
        select: { soldAt: true, grandTotal: true },
        orderBy: { soldAt: "asc" },
      }),
      client.goodsReturn.findMany({
        where: { tenantId, shiftId },
        select: {
          id: true,
          returnNumber: true,
          amount: true,
          createdAt: true,
          processedBy: true,
          sale: { select: { invoiceNo: true } },
          items: { select: { qty: true, disposition: true, product: { select: { name: true } } } },
        },
        orderBy: { createdAt: "asc" },
      }),
      client.tillCashMovement.findMany({ where: { tenantId, shiftId }, orderBy: { recordedAt: "asc" } }),
      client.branch.findFirst({ where: { tenantId, id: shift.branchId }, select: { timezone: true } }),
    ]);

    const byMethod = new Map<PaymentMethod, { sales: Set<string>; takenMinor: number; refundedMinor: number }>();
    // A refund's money back is its negative payments, which applyRefund references by return number.
    const paidBack = new Map<string, Array<{ method: PaymentMethod; amountMinor: number }>>();
    for (const payment of payments) {
      const entry = byMethod.get(payment.method) ?? { sales: new Set<string>(), takenMinor: 0, refundedMinor: 0 };
      const minor = toMinor(payment.amount);
      if (minor >= 0) {
        entry.takenMinor += minor;
        entry.sales.add(payment.saleId);
      } else {
        entry.refundedMinor -= minor;
        const back = paidBack.get(payment.reference ?? "") ?? [];
        back.push({ method: payment.method, amountMinor: -minor });
        paidBack.set(payment.reference ?? "", back);
      }
      byMethod.set(payment.method, entry);
    }
    const cash = byMethod.get(PaymentMethod.cash);
    if (cash) cash.takenMinor -= parts.changeGivenMinor;

    const timeZone = safeTimeZone(branch?.timezone);
    const byHour = new Map<string, { saleCount: number; totalMinor: number }>();
    for (const sale of sales) {
      const key = branchHourKey(timeZone, sale.soldAt);
      const entry = byHour.get(key) ?? { saleCount: 0, totalMinor: 0 };
      entry.saleCount += 1;
      entry.totalMinor += toMinor(sale.grandTotal);
      byHour.set(key, entry);
    }

    const people = await this.names(tenantId, [
      ...movements.map((m) => m.recordedBy),
      ...refunds.map((r) => r.processedBy).filter((id): id is string => !!id),
    ]);
    const methodOrder = Object.values(PaymentMethod);
    return {
      ...parts,
      expectedCashMinor: shift.closedAt ? shift.expectedCashMinor! : expectedCash(parts),
      saleCount: sales.length,
      salesTotalMinor: sales.reduce((sum, sale) => sum + toMinor(sale.grandTotal), 0),
      takingsByMethod: [...byMethod.entries()]
        .sort(([a], [b]) => methodOrder.indexOf(a) - methodOrder.indexOf(b))
        .map(([method, entry]) => ({
          method,
          saleCount: entry.sales.size,
          takenMinor: entry.takenMinor,
          refundedMinor: entry.refundedMinor,
        })),
      firstSaleAt: sales[0]?.soldAt.toISOString() ?? null,
      lastSaleAt: sales.at(-1)?.soldAt.toISOString() ?? null,
      takingsByHour: [...byHour.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([hour, entry]) => ({ hour, ...entry })),
      refunds: refunds.map((r) => ({
        goodsReturnId: r.id,
        returnNumber: r.returnNumber,
        invoiceNo: r.sale?.invoiceNo ?? null,
        amountMinor: toMinor(r.amount),
        paidBack: paidBack.get(`POS refund ${r.returnNumber}`) ?? [],
        items: r.items.map((item) => ({ name: item.product.name, qty: item.qty, disposition: item.disposition })),
        processedBy: r.processedBy ? people.get(r.processedBy) ?? null : null,
        at: r.createdAt.toISOString(),
      })),
      cashMovements: movements.map((m) => ({
        id: m.id,
        direction: m.direction,
        amountMinor: m.amountMinor,
        reason: m.reason,
        referenceType: m.referenceType,
        at: m.recordedAt.toISOString(),
        recordedBy: people.get(m.recordedBy) ?? null,
      })),
    };
  }

  private async views(tenantId: string, rows: TillShift[]) {
    const people = await this.names(
      tenantId,
      rows.flatMap((row) => [row.staffUserId, row.closedByUserId].filter((id): id is string => !!id)),
    );
    return new Map(
      rows.map((row): [string, TillShiftView] => [
        row.id,
        {
          workSessionId: row.id,
          registerId: row.registerId,
          tillId: row.tillId,
          terminalId: row.terminalId,
          staffUserId: row.staffUserId,
          staff: people.get(row.staffUserId) ?? null,
          currency: "LKR",
          status: row.closedAt ? "closed" : "open",
          openedAt: row.openedAt.toISOString(),
          openingCashMinor: row.openingCashMinor,
          openingCount: row.openingCount as unknown as CashCount["lines"],
          previousClosedWorkSessionId: row.previousClosedWorkSessionId,
          closedAt: row.closedAt?.toISOString() ?? null,
          closingCashCountMinor: row.closingCashCountMinor,
          closingCount: (row.closingCount as unknown as CashCount["lines"] | null) ?? null,
          expectedCashMinor: row.expectedCashMinor,
          counterExpectedCashMinor: row.counterExpectedCashMinor,
          varianceMinor: row.varianceMinor,
          closedBy: row.closedByUserId ? people.get(row.closedByUserId) ?? null : null,
          closeKind: row.closeKind,
          assistanceReason: row.assistanceReason,
          varianceNote: row.varianceNote,
        },
      ]),
    );
  }

  private async names(tenantId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map<string, { id: string; fullName: string }>();
    // tenant-scope: verified-parent — the membership filter scopes the accounts to this tenant.
    const rows = await this.prisma.appUser.findMany({
      where: { id: { in: unique }, tenantMemberships: { some: { tenantId } } },
      select: { id: true, fullName: true },
    });
    return new Map(rows.map((row) => [row.id, row]));
  }

  private async person(tx: Tx, tenantId: string, userId: string) {
    // tenant-scope: verified-parent — the membership filter scopes the account to this tenant.
    return tx.appUser.findFirst({
      where: { id: userId, tenantMemberships: { some: { tenantId } } },
      select: { id: true, fullName: true },
    });
  }

  /** The caller's own PIN against the server verifier and lockout. A wrong one is counted in
   * this transaction, so the caller commits and refuses after. */
  private async checkOwnPin(tx: Tx, user: RequestUser, pin: string): Promise<PinRefused | null> {
    // tenant-scope: verified-parent — the caller's open counter session was verified above.
    const account = await tx.appUser.findFirst({
      where: { id: user.userId, isActive: true, tenantMemberships: { some: { tenantId: user.tenantId, isActive: true } } },
      select: { id: true, posPinHash: true, posPinLockedUntil: true, posPinLockouts: true },
    });
    if (!account) throw new ForbiddenException({ code: "PERMISSION_DENIED", message: "Your account can't do this here." });
    const checked = await checkPosPin(tx, account, pin, new Date());
    return checked.outcome === "ok" ? null : checked;
  }

  private async refusePin(user: RequestUser, branchId: string, refused: PinRefused): Promise<never> {
    if (refused.switchedOff) await this.alerts.switchedOff(user.tenantId, branchId, user.userId);
    pinRefusal(refused.outcome, refused.lockedUntil);
  }
}
