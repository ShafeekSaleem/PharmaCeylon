import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  CounterMismatchStatus,
  HeldDeliveryStatus,
  PreparedReceiptStatus,
  type Prisma,
  TransferStatus,
} from "@prisma/client";
import {
  COUNTER_MISMATCH_HOLDS,
  COUNTER_MISMATCH_NEEDS_COUNT,
  COUNTER_MISMATCH_PROBLEMS_BY_KIND,
  type CounterMismatchKind,
  type CounterMismatchLine,
  type CounterMismatchReport,
  type CounterWorkReceiptLine,
  type CounterWorkTransferLine,
} from "@pharmaceylon/shared";
import { AuditService } from "../audit/audit.service";
import { IDEMPOTENCY_SCOPE } from "../common/idempotency.constants";
import { isPrismaUniqueFieldError, normalizeIdempotencyKey } from "../common/idempotency.util";
import { PrismaService } from "../prisma/prisma.service";
import { AccessService } from "../security/access.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CounterWorkDetailService } from "./counter-work-detail.service";
import type { DismissCounterMismatchDto, ReportCounterMismatchDto } from "./dto/counter-mismatch.dto";

type Row = Prisma.CounterMismatchReportGetPayload<{}>;
type Client = Prisma.TransactionClient | PrismaService;

/** Who may see a report on the web, and who may dismiss it: the document's own permissions. */
const VIEW: Record<CounterMismatchKind, string> = {
  prepared_receipt: "purchasing.view",
  held_delivery: "purchasing.view",
  transfer_ship: "transfers.view",
  transfer_receive: "transfers.view",
};
const APPROVE: Record<CounterMismatchKind, string> = {
  prepared_receipt: "purchasing.approve",
  held_delivery: "purchasing.approve",
  transfer_ship: "transfers.approve",
  transfer_receive: "transfers.approve",
};

/** Problems the counter can only describe in words: which product, which batch. */
const NEEDS_NOTE = new Set(["not_on_note", "different_batch_or_expiry"]);

/** Whether `row` still holds `currentApprovalId`, the approval the document carries now. */
function holds(row: Pick<Row, "kind" | "status" | "approvalId">, currentApprovalId: string | null) {
  return (
    row.status === CounterMismatchStatus.open &&
    COUNTER_MISMATCH_HOLDS[row.kind as CounterMismatchKind] &&
    row.approvalId === currentApprovalId
  );
}

function line(row: Row): CounterMismatchLine | null {
  if (row.lineRef == null) return null;
  return row.kind === "transfer_ship" || row.kind === "transfer_receive"
    ? { transferItemId: row.lineRef }
    : { index: Number(row.lineRef) };
}

async function names(client: Client, tenantId: string, rows: Row[]) {
  const ids = [...new Set(rows.flatMap((r) => [r.reportedBy, r.dismissedBy]).filter((id): id is string => !!id))];
  if (!ids.length) return new Map<string, string>();
  const users = await client.appUser.findMany({
    where: { tenantId, id: { in: ids } },
    select: { id: true, fullName: true },
  });
  return new Map(users.map((u) => [u.id, u.fullName]));
}

function toReport(row: Row, byId: Map<string, string>, holding: boolean): CounterMismatchReport {
  return {
    id: row.id,
    kind: row.kind as CounterMismatchKind,
    documentId: row.documentId,
    reference: row.reference,
    approvalId: row.approvalId,
    documentVersion: row.documentVersion,
    line: line(row),
    lineLabel: row.lineLabel,
    problem: row.problem,
    countedQty: row.countedQty,
    countUnit: row.countUnit === "packs" || row.countUnit === "units" ? row.countUnit : null,
    note: row.note,
    status: row.status,
    holding,
    reported: { name: byId.get(row.reportedBy) ?? null, at: row.reportedAt.toISOString() },
    dismissed: row.dismissedBy
      ? { name: byId.get(row.dismissedBy) ?? null, at: row.dismissedAt?.toISOString() ?? null }
      : null,
    dismissNote: row.dismissNote,
  };
}

/**
 * The reports Counter work shows on its items: open, and still about the approval the item
 * carries now. A report against an approval since replaced (a corrected version was approved)
 * has done its job and is left out. A transfer in has no approval to replace; its reports show
 * while it is still on the way, which is while it is in the list at all.
 */
export async function currentMismatches(
  client: Client,
  tenantId: string,
  branchId: string,
  items: ReadonlyArray<{ kind: string; id: string; evidenceId: string | null }>,
): Promise<Map<string, CounterMismatchReport[]>> {
  const wanted = items.filter((i) => i.kind in COUNTER_MISMATCH_HOLDS);
  const result = new Map<string, CounterMismatchReport[]>();
  if (!wanted.length) return result;
  const rows = await client.counterMismatchReport.findMany({
    where: {
      tenantId,
      branchId,
      status: CounterMismatchStatus.open,
      documentId: { in: wanted.map((i) => i.id) },
    },
    orderBy: { reportedAt: "asc" },
  });
  if (!rows.length) return result;
  const byId = await names(client, tenantId, rows);
  for (const item of wanted) {
    const kind = item.kind as CounterMismatchKind;
    const reports = rows
      .filter((r) => r.kind === kind && r.documentId === item.id)
      .filter((r) => !COUNTER_MISMATCH_HOLDS[kind] || r.approvalId === item.evidenceId)
      .map((r) => toReport(r, byId, holds(r, item.evidenceId)));
    if (reports.length) result.set(`${kind}:${item.id}`, reports);
  }
  return result;
}

/**
 * P6 #52 decision 1. The counter confirms approved documents as they stand and never edits
 * them; when what is in front of it doesn't match, it says so here. The report goes to the
 * approver's Daily work and, for a delivery or a transfer out, holds the approval the counter
 * saw (`assertNoMismatchHold`) until a corrected version is approved or the approver keeps it.
 */
@Injectable()
export class CounterMismatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly details: CounterWorkDetailService,
  ) {}

  async report(
    user: RequestUser,
    branchId: string,
    dto: ReportCounterMismatchDto,
    idempotencyKeyRaw?: string,
  ): Promise<CounterMismatchReport> {
    const { tenantId, userId } = user;
    const idemKey = normalizeIdempotencyKey(idempotencyKeyRaw);
    const replay = async () => {
      const record = await this.prisma.idempotencyRecord.findUnique({
        where: {
          tenantId_userId_scope_idempotencyKey: {
            tenantId, userId, scope: IDEMPOTENCY_SCOPE.counterMismatchReport, idempotencyKey: idemKey!,
          },
        },
      });
      if (!record) return null;
      const row = await this.prisma.counterMismatchReport.findFirst({
        where: { tenantId, branchId, id: record.resourceId },
      });
      if (!row || row.documentId !== dto.documentId)
        throw new BadRequestException("Idempotency-Key already used for a different report");
      return this.one(row);
    };
    if (idemKey) {
      const earlier = await replay();
      if (earlier) return earlier;
    }

    // Readable only while it waits in this branch's Counter work, to someone who may execute it.
    const detail = await this.details.detail(user, branchId, dto.kind, dto.documentId);
    if (detail.approval.state === "changed" || detail.approval.state === "revoked")
      throw new ConflictException("This is already waiting to be approved again on the web.");
    if (
      (detail.approval.evidenceId ?? null) !== (dto.approvalId ?? null) ||
      detail.approval.currentVersion !== dto.documentVersion
    )
      throw new ConflictException("This changed since you opened it. Open it again.");

    if (!COUNTER_MISMATCH_PROBLEMS_BY_KIND[dto.kind].includes(dto.problem))
      throw new BadRequestException(`"${dto.problem}" is not a choice here.`);
    const note = dto.note?.trim() || null;
    if (NEEDS_NOTE.has(dto.problem) && !note)
      throw new BadRequestException("Add a note saying what you found.");
    const counted = dto.countedQty ?? null;
    if (COUNTER_MISMATCH_NEEDS_COUNT.includes(dto.problem) && counted === null)
      throw new BadRequestException("Enter the count.");

    let lineRef: string | null = null;
    let lineLabel: string | null = null;
    let countUnit: "packs" | "units" | null = counted === null ? null : "units";
    if (dto.problem === "not_on_note") {
      if (dto.line) throw new BadRequestException("Something not on the note has no line; leave the line out.");
    } else {
      if (!dto.line) throw new BadRequestException("Choose the line.");
      if (detail.kind === "transfer_ship" || detail.kind === "transfer_receive") {
        const found = (detail.lines as ReadonlyArray<CounterWorkTransferLine>).find(
          (l) => l.transferItemId === dto.line!.transferItemId,
        );
        if (!found || dto.line.index !== undefined) throw new BadRequestException("That line is not on this transfer.");
        lineRef = found.transferItemId;
        lineLabel = found.productName;
        const expected = detail.kind === "transfer_ship" ? found.qty : found.remainingQty;
        this.checkCount(dto.problem, counted, expected, "units");
      } else if (detail.kind === "prepared_receipt" || detail.kind === "held_delivery") {
        const found = (detail.lines as ReadonlyArray<CounterWorkReceiptLine>).find(
          (l) => l.index === dto.line!.index,
        );
        if (!found || dto.line.transferItemId !== undefined) throw new BadRequestException("That line is not on this delivery.");
        lineRef = String(found.index);
        lineLabel = found.productName;
        if (counted !== null && found.packs != null) countUnit = "packs";
        const expected = found.packs ?? found.receivedQty + found.freeQty + found.damagedQty;
        this.checkCount(dto.problem, counted, expected, found.packs != null ? "packs" : "units");
      }
    }

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.counterMismatchReport.create({
          data: {
            tenantId,
            branchId,
            kind: dto.kind,
            documentId: dto.documentId,
            reference: detail.reference.slice(0, 64),
            approvalId: dto.approvalId ?? null,
            documentVersion: dto.documentVersion,
            lineRef,
            lineLabel: lineLabel?.slice(0, 255) ?? null,
            problem: dto.problem,
            countedQty: counted,
            countUnit,
            note,
            reportedBy: userId,
          },
        });
        if (idemKey)
          await tx.idempotencyRecord.create({
            data: {
              tenantId, userId, scope: IDEMPOTENCY_SCOPE.counterMismatchReport, idempotencyKey: idemKey,
              resourceId: created.id,
            },
          });
        await this.audit.log(
          {
            tenantId,
            branchId,
            actorUserId: userId,
            eventName: "counter_work.mismatch_reported",
            entityName: dto.kind,
            entityId: dto.documentId,
            payload: {
              reportId: created.id,
              approvalId: created.approvalId,
              documentVersion: created.documentVersion,
              lineRef,
              problem: created.problem,
              countedQty: counted,
              countUnit,
              holdsApproval: COUNTER_MISMATCH_HOLDS[dto.kind],
            },
          },
          tx,
        );
        return created;
      });
      return this.one(row);
    } catch (e) {
      if (idemKey && isPrismaUniqueFieldError(e, "idempotency")) {
        const earlier = await replay();
        if (earlier) return earlier;
      }
      throw e;
    }
  }

  private checkCount(
    problem: ReportCounterMismatchDto["problem"],
    counted: number | null,
    expected: number,
    unit: "packs" | "units",
  ) {
    if (counted === null) return;
    if (problem === "fewer_arrived" && counted >= expected)
      throw new BadRequestException(`Fewer than ${expected} ${unit} arrived? Enter what did.`);
    if (problem === "more_arrived" && counted <= expected)
      throw new BadRequestException(`More than ${expected} ${unit} arrived? Enter what did.`);
    if (problem === "cannot_pick" && counted >= expected)
      throw new BadRequestException(`Enter how many of the ${expected} ${unit} you can pick.`);
    if (problem === "damaged" && counted < 1) throw new BadRequestException("Enter how many are damaged.");
  }

  /** The approver keeps the document as it is: the approval it saw is free to execute again. */
  async dismiss(
    user: RequestUser,
    branchId: string,
    id: string,
    dto: DismissCounterMismatchDto,
  ): Promise<CounterMismatchReport> {
    const { tenantId, userId } = user;
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM counter_mismatch_report WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${id}::uuid FOR UPDATE`;
      const report = await tx.counterMismatchReport.findFirst({ where: { tenantId, branchId, id } });
      if (!report) throw new NotFoundException("Report not found");
      const kind = report.kind as CounterMismatchKind;
      const actor = await this.access.resolveLive(user, branchId, tx);
      if (!actor.has(APPROVE[kind]))
        throw new ForbiddenException(`You need ${APPROVE[kind]} at this branch to answer this.`);
      // The counter can't clear its own report: someone who may approve the document reads it.
      if (report.reportedBy === userId && !actor.canSelfApprove)
        throw new ForbiddenException("Another approver needs to answer a report you sent.");
      if (report.status !== CounterMismatchStatus.open)
        throw new ConflictException("This report was already answered.");
      const updated = await tx.counterMismatchReport.update({
        where: { id: report.id, tenantId },
        data: {
          status: CounterMismatchStatus.dismissed,
          dismissedBy: userId,
          dismissedAt: new Date(),
          dismissNote: dto.note?.trim() || null,
        },
      });
      await this.audit.log(
        {
          tenantId,
          branchId,
          actorUserId: userId,
          eventName: "counter_work.mismatch_dismissed",
          entityName: kind,
          entityId: report.documentId,
          payload: { reportId: report.id, approvalId: report.approvalId, note: updated.dismissNote },
        },
        tx,
      );
      return updated;
    });
    return this.one(row);
  }

  /** Every report sent about one document at this branch, newest first, for its web page. */
  async forDocument(
    user: RequestUser,
    branchId: string,
    kind: CounterMismatchKind,
    documentId: string,
  ): Promise<CounterMismatchReport[]> {
    const actor = await this.access.resolve(user, branchId);
    if (!actor.has(VIEW[kind])) throw new ForbiddenException(`You need ${VIEW[kind]} at this branch.`);
    const rows = await this.prisma.counterMismatchReport.findMany({
      where: { tenantId: user.tenantId, branchId, kind, documentId },
      orderBy: { reportedAt: "desc" },
    });
    if (!rows.length) return [];
    const [byId, current] = await Promise.all([
      names(this.prisma, user.tenantId, rows),
      this.currentApproval(user.tenantId, kind, documentId),
    ]);
    return rows.map((r) => toReport(r, byId, current.awaiting && holds(r, current.approvalId)));
  }

  private async one(row: Row): Promise<CounterMismatchReport> {
    const byId = await names(this.prisma, row.tenantId, [row]);
    const current = await this.currentApproval(row.tenantId, row.kind as CounterMismatchKind, row.documentId);
    return toReport(row, byId, current.awaiting && holds(row, current.approvalId));
  }

  /** The approval the document carries now, and whether it still waits at the counter. */
  private async currentApproval(tenantId: string, kind: CounterMismatchKind, id: string) {
    const where = { tenantId, id };
    const select = { executionApprovalId: true, status: true } as const;
    switch (kind) {
      case "prepared_receipt": {
        const r = await this.prisma.preparedReceipt.findFirst({ where, select });
        return { approvalId: r?.executionApprovalId ?? null, awaiting: r?.status === PreparedReceiptStatus.approved };
      }
      case "held_delivery": {
        const r = await this.prisma.heldDelivery.findFirst({ where, select });
        return { approvalId: r?.executionApprovalId ?? null, awaiting: r?.status === HeldDeliveryStatus.approved };
      }
      case "transfer_ship": {
        const r = await this.prisma.transfer.findFirst({ where, select });
        return { approvalId: r?.executionApprovalId ?? null, awaiting: r?.status === TransferStatus.approved };
      }
      case "transfer_receive": {
        const r = await this.prisma.transfer.findFirst({ where, select });
        return {
          approvalId: r?.executionApprovalId ?? null,
          awaiting: r?.status === TransferStatus.in_transit || r?.status === TransferStatus.partially_received,
        };
      }
    }
  }
}
