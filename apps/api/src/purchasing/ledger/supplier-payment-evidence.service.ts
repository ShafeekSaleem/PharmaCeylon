import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, SupplierPaymentEvidence } from "@prisma/client";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { AuditService } from "../../audit/audit.service";
import { businessDateKey } from "../../common/business-date.util";
import { PrismaService } from "../../prisma/prisma.service";
import { AccessService } from "../../security/access.service";
import { RequestUser } from "../../security/interfaces/authenticated-request.interface";
import { denied } from "../../terminals/terminal-wire";
import {
  EVIDENCED_PAYMENT_OPERATION,
  EvidencedPayment,
  evidenceMaterialDigest,
  evidenceUuid,
  parseEvidencedPayment,
  parseEvidencedRequest,
} from "./payment-evidence-material";

export const PAYMENT_EVIDENCE_FILE_LIMIT = 5 * 1024 * 1024;
export type PaymentEvidenceContext = {
  tenantId: string;
  branchId: string;
  actorUserId: string;
  operation: string;
  body: unknown;
};

/** Uploaded supporting records, not a bank/provider confirmation. Bytes are private and
 * immutable; public image-upload URLs have no trusted ownership and are never accepted. */
@Injectable()
export class SupplierPaymentEvidenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  async upload(
    user: RequestUser,
    branchId: string,
    id: string,
    material: unknown,
    file: Express.Multer.File,
  ) {
    id = evidenceUuid(id);
    const payment = parseEvidencedPayment(material);
    const { content, mediaType, contentDigest } = await this.file(file);
    const materialDigest = evidenceMaterialDigest(payment);
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await this.authorize(tx, user, branchId);
          const invoiceDigest = await this.invoices(
            tx,
            user.tenantId,
            branchId,
            payment,
            false,
          );
          await this.lock(tx, user.tenantId, branchId, id);
          const existing = await tx.supplierPaymentEvidence.findFirst({
            where: { tenantId: user.tenantId, branchId, id },
          });
          if (existing) {
            if (
              existing.uploadedBy !== user.userId ||
              existing.materialDigest !== materialDigest ||
              existing.contentDigest !== contentDigest ||
              existing.invoiceDigest !== invoiceDigest ||
              existing.revokedAt
            )
              throw new ConflictException(
                "Evidence ID already belongs to a different or revoked upload.",
              );
            await this.authorize(tx, user, branchId);
            return this.metadata(existing);
          }
          await this.invoices(tx, user.tenantId, branchId, payment, true);
          const saved = await tx.supplierPaymentEvidence.create({
            data: {
              id,
              tenantId: user.tenantId,
              branchId,
              supplierId: payment.supplierId,
              uploadedBy: user.userId,
              paymentMaterial: payment as unknown as Prisma.InputJsonValue,
              materialDigest,
              invoiceDigest,
              contentDigest,
              mediaType,
              content,
            },
          });
          await this.audit.log(
            {
              tenantId: user.tenantId,
              branchId,
              actorUserId: user.userId,
              eventName: "supplier_payment.evidence_uploaded",
              entityName: "supplier_payment_evidence",
              entityId: id,
              payload: {
                supplierId: payment.supplierId,
                materialDigest,
                contentDigest,
                bytes: content.length,
                mediaType,
              },
            },
            tx,
          );
          await this.authorize(tx, user, branchId);
          return this.metadata(saved);
        },
        { timeout: 30_000 },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        // Retried identical intake can race without an existing row to lock. Read only after
        // the winner committed; changed bindings never acquire that upload's authority.
        return this.prisma.$transaction(async (tx) => {
          await this.authorize(tx, user, branchId);
          const invoiceDigest = await this.invoices(
            tx,
            user.tenantId,
            branchId,
            payment,
            false,
          );
          await this.lock(tx, user.tenantId, branchId, id);
          const saved = await tx.supplierPaymentEvidence.findFirst({
            where: { tenantId: user.tenantId, branchId, id },
          });
          if (
            !saved ||
            saved.uploadedBy !== user.userId ||
            saved.materialDigest !== materialDigest ||
            saved.contentDigest !== contentDigest ||
            saved.invoiceDigest !== invoiceDigest ||
            saved.revokedAt
          ) {
            throw new ConflictException(
              "This document already supports another active payment evidence record. Revoke an unused incorrect binding before replacing it.",
            );
          }
          await this.authorize(tx, user, branchId);
          return this.metadata(saved);
        });
      }
      throw error;
    }
  }

  async read(user: RequestUser, branchId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.authorize(tx, user, branchId);
      const row = await tx.supplierPaymentEvidence.findFirst({
        where: { tenantId: user.tenantId, branchId, id },
      });
      if (!row) throw new NotFoundException("Payment evidence not found.");
      if (digestBytes(row.content) !== row.contentDigest)
        denied("PAYMENT_EVIDENCE_REQUIRED");
      await this.authorize(tx, user, branchId);
      return row;
    });
  }

  async revoke(
    user: RequestUser,
    branchId: string,
    id: string,
    reason: string,
  ) {
    if (typeof reason !== "string" || !reason.trim() || reason.length > 500)
      throw new BadRequestException(
        "Give a revocation reason (at most 500 characters).",
      );
    return this.prisma.$transaction(async (tx) => {
      await this.authorize(tx, user, branchId);
      await this.lock(tx, user.tenantId, branchId, id);
      const row = await tx.supplierPaymentEvidence.findFirst({
        where: { tenantId: user.tenantId, branchId, id },
      });
      if (!row) throw new NotFoundException("Payment evidence not found.");
      await this.authorize(tx, user, branchId);
      if (
        row.uploadedBy !== user.userId &&
        !(await this.access.resolveLive(user, branchId, tx)).has(
          "tenant.management",
        )
      )
        denied("PERMISSION_DENIED");
      if (row.consumedPaymentId)
        throw new ConflictException(
          "The payment is already recorded. Correct its ledger record; its original evidence stays retained.",
        );
      if (row.revokedAt) return this.metadata(row);
      const next = await tx.supplierPaymentEvidence.update({
        where: { tenantId: user.tenantId, id },
        data: {
          revokedAt: new Date(),
          revokedBy: user.userId,
          revocationReason: reason.trim(),
        },
      });
      await this.audit.log(
        {
          tenantId: user.tenantId,
          branchId,
          actorUserId: user.userId,
          eventName: "supplier_payment.evidence_revoked",
          entityName: "supplier_payment_evidence",
          entityId: id,
          payload: { reason: reason.trim(), uploadedBy: row.uploadedBy },
        },
        tx,
      );
      await this.authorize(tx, user, branchId);
      if (
        row.uploadedBy !== user.userId &&
        !(await this.access.resolveLive(user, branchId, tx)).has(
          "tenant.management",
        )
      )
        denied("PERMISSION_DENIED");
      return this.metadata(next);
    });
  }

  /** The normal bank evidence port never authorizes a consumed document for another write. */
  async assertForContext(
    tx: Prisma.TransactionClient,
    context: PaymentEvidenceContext,
  ) {
    const row = await this.forRecording(tx, context);
    if (row.consumedPaymentId) denied("PAYMENT_EVIDENCE_REQUIRED");
  }

  /** Invoice locks precede evidence locks everywhere. Same evidence retries can return its
   * original payment before checking outstanding balance, which that payment already settled. */
  async forRecording(
    tx: Prisma.TransactionClient,
    context: PaymentEvidenceContext,
    checkBalance = true,
  ) {
    if (context.operation !== EVIDENCED_PAYMENT_OPERATION)
      denied("PAYMENT_EVIDENCE_REQUIRED");
    const body = parseEvidencedRequest(context.body);
    const invoiceDigest = await this.invoices(
      tx,
      context.tenantId,
      context.branchId,
      body.payment,
      false,
    );
    await this.lock(tx, context.tenantId, context.branchId, body.evidenceId);
    const row = await tx.supplierPaymentEvidence.findFirst({
      where: {
        tenantId: context.tenantId,
        branchId: context.branchId,
        id: body.evidenceId,
      },
    });
    if (
      !row ||
      row.uploadedBy !== context.actorUserId ||
      row.revokedAt ||
      row.materialDigest !== evidenceMaterialDigest(body.payment) ||
      row.invoiceDigest !== invoiceDigest ||
      digestBytes(row.content) !== row.contentDigest ||
      evidenceMaterialDigest(row.paymentMaterial) !== row.materialDigest
    )
      denied("PAYMENT_EVIDENCE_REQUIRED");
    const current = await this.access.resolveApprovalAuthority(
      { tenantId: context.tenantId, userId: row.uploadedBy },
      context.branchId,
      tx,
    );
    if (!current.has("suppliers.pay")) denied("PERMISSION_DENIED");
    if (!row.consumedPaymentId && checkBalance)
      await this.invoices(
        tx,
        context.tenantId,
        context.branchId,
        body.payment,
        true,
      );
    return row;
  }

  async consume(
    tx: Prisma.TransactionClient,
    context: PaymentEvidenceContext,
    paymentId: string,
  ) {
    const row = await this.forRecording(tx, context, false);
    if (row.consumedPaymentId) denied("PAYMENT_EVIDENCE_REQUIRED");
    const payment = await tx.supplierPayment.findFirst({
      where: {
        tenantId: context.tenantId,
        branchId: context.branchId,
        id: paymentId,
      },
      include: { allocations: true },
    });
    if (!payment) denied("PAYMENT_EVIDENCE_REQUIRED");
    const material = parseEvidencedPayment({
      supplierId: payment.supplierId,
      paidOn: payment.paidOn.toISOString().slice(0, 10),
      amount: payment.amount.toFixed(2),
      method: payment.method,
      reference: payment.reference,
      notes: payment.notes,
      allocations: payment.allocations.map((part) => ({
        invoiceId: part.invoiceId,
        amount: part.amount.toFixed(2),
      })),
    });
    if (evidenceMaterialDigest(material) !== row.materialDigest)
      denied("PAYMENT_EVIDENCE_REQUIRED");
    await tx.supplierPaymentEvidence.update({
      where: { tenantId: context.tenantId, id: row.id },
      data: { consumedPaymentId: paymentId, consumedAt: new Date() },
    });
  }

  async authorize(
    tx: Prisma.TransactionClient,
    user: RequestUser,
    branchId: string,
  ) {
    if (
      !(await this.access.resolveLive(user, branchId, tx)).has("suppliers.pay")
    )
      denied("PERMISSION_DENIED");
  }

  private async lock(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
    id: string,
  ) {
    await tx.$queryRaw`SELECT id FROM supplier_payment_evidence WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${id}::uuid FOR UPDATE`;
  }

  private async invoices(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
    payment: EvidencedPayment,
    checkBalance: boolean,
  ) {
    const ids = payment.allocations.map((part) => part.invoiceId).sort();
    await tx.$queryRaw`SELECT id FROM supplier_invoice WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
    const rows = await tx.supplierInvoice.findMany({
      where: {
        tenantId,
        branchId,
        supplierId: payment.supplierId,
        id: { in: ids },
      },
      select: {
        id: true,
        supplierId: true,
        branchId: true,
        invoiceNumber: true,
        invoiceDate: true,
        totalAmount: true,
        paidAmount: true,
        status: true,
      },
      orderBy: { id: "asc" },
    });
    if (
      rows.length !== ids.length ||
      rows.some((row) => row.status === "voided")
    )
      denied("PAYMENT_EVIDENCE_REQUIRED");
    const branch = await tx.branch.findFirst({
      where: { tenantId, id: branchId },
      select: { timezone: true },
    });
    if (!branch || payment.paidOn > businessDateKey(branch.timezone))
      throw new BadRequestException("Payment date is in the future.");
    if (
      checkBalance &&
      rows.some((row) =>
        new Prisma.Decimal(
          payment.allocations.find((part) => part.invoiceId === row.id)!.amount,
        ).gt(row.totalAmount.minus(row.paidAmount)),
      )
    ) {
      throw new ConflictException(
        "An invoice balance changed. Review the payment allocations before recording.",
      );
    }
    return evidenceMaterialDigest(
      rows.map((row) => ({
        id: row.id,
        supplierId: row.supplierId,
        branchId: row.branchId,
        invoiceNumber: row.invoiceNumber,
        invoiceDate: row.invoiceDate.toISOString(),
        totalAmount: row.totalAmount.toFixed(2),
      })),
    );
  }

  private metadata(row: SupplierPaymentEvidence) {
    return {
      evidenceId: row.id,
      payment: row.paymentMaterial,
      materialDigest: row.materialDigest,
      contentDigest: row.contentDigest,
      mediaType: row.mediaType,
      createdAt: row.createdAt,
      consumedPaymentId: row.consumedPaymentId,
      revokedAt: row.revokedAt,
    };
  }

  private async file(file: Express.Multer.File) {
    if (
      !file?.buffer?.length ||
      file.buffer.length > PAYMENT_EVIDENCE_FILE_LIMIT
    )
      throw new BadRequestException("Upload a PDF or image of at most 5 MB.");
    const content = Buffer.from(file.buffer);
    let mediaType: string;
    if (
      content.subarray(0, 5).toString("ascii") === "%PDF-" &&
      content.subarray(-2048).includes(Buffer.from("%%EOF"))
    )
      mediaType = "application/pdf";
    else {
      try {
        const image = await sharp(content, {
          limitInputPixels: 25_000_000,
        }).metadata();
        const types: Record<string, string> = {
          jpeg: "image/jpeg",
          png: "image/png",
          webp: "image/webp",
        };
        mediaType = types[image.format ?? ""];
        if (!mediaType || !image.width || !image.height)
          throw new Error("Unsupported image");
      } catch {
        throw new BadRequestException(
          "Evidence must be a PDF, JPEG, PNG or WebP document.",
        );
      }
    }
    if (file.mimetype !== mediaType)
      throw new BadRequestException(
        "Evidence file type does not match its contents.",
      );
    return { content, mediaType, contentDigest: digestBytes(content) };
  }
}

const digestBytes = (content: Uint8Array) =>
  createHash("sha256").update(content).digest("hex");
